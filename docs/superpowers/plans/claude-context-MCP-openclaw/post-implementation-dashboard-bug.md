# Control UI Dashboard 503 — Post-Implementation Bug Report

**Date:** 2026-05-20 (afternoon, UTC)
**Author:** Claude (Opus 4.7) during live verification after the 2026-05-20 QMD / retrieval-stack work
**Related work:** `docs/superpowers/plans/2026-05-20-bootstrap-tool-reinforcement.md`, `docs/superpowers/specs/2026-05-20-qmd-subagent-parity-design.md`, commit `9fd60cf28f` (`fix(runtime): harden qmd first-pass recall and subagent parity`)
**Trigger:** Web dashboard returned `Control UI assets not found. Build them with pnpm ui:build ...` (HTTP 503 on `http://127.0.0.1:18789/`) while Discord chat kept working.

Severity: **P1** (user-visible dashboard fully down) — **RESOLVED** same session. Not a code regression; a missing build artifact plus a boot-cached resolver state.

---

## Status Index

| #   | Title                                                              | Severity      |
| --- | ---------------------------------------------------------------- | ------------- |
| 1   | Control UI 503 after `dist/` regen without `ui:build` + restart  | P1 — resolved |

---

## 1. Control UI assets missing → gateway 503

### Observation

```
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/      # 503
$ curl -s http://127.0.0.1:18789/ | head -c 80
Control UI assets not found. Build them with `pnpm ui:build` ...

$ ls dist/control-ui/index.html                                       # No such file
$ docker exec openclaw-openclaw-gateway-1 ls /app/dist/control-ui/index.html   # No such file
```

`dist/.buildstamp` and `dist/.runtime-postbuildstamp` were both dated `2026-05-20 14:19` — a `pnpm build` ran during the QMD work — yet `dist/control-ui/` did not exist on host or in the container.

### Root cause

Two independent facts combine:

1. **`pnpm build` does not build the Control UI.** The UI is a separate step — `pnpm ui:build` (→ `node scripts/ui.js build`) emits to `dist/control-ui/` per `ui/vite.config.ts:31`. `scripts/build-all.mjs` neither cleans `dist/` nor references control-ui. `dist/` is gitignored, so the assets exist **only** when locally built. A fresh `pnpm build` regenerated the JS bundles but left `dist/control-ui/` absent.

2. **The gateway caches the UI-root state at boot.** `src/gateway/server.impl.ts:771` resolves the control-ui root once at startup (via `resolveControlUiRootSync`, `src/infra/control-ui-assets.ts:188`). Because the assets were missing at boot, it cached `{ kind: "missing" }`. In the request handler, `src/gateway/control-ui.ts:890-892` short-circuits a `"missing"` state straight to 503 — the per-request re-resolve fallback (`control-ui.ts:895-902`) only fires when **no** state was passed, never when state is explicitly `"missing"`. So even after the assets are rebuilt, the running gateway keeps 503-ing until restarted.

Discord is unaffected because it does not depend on these assets.

### Fix (two parts, both required)

```bash
# 1. Build the Control UI into dist/control-ui (visible in-container via the
#    ./dist:/app/dist bind mount — no image rebuild). Built in ~2.87s; UI deps
#    were already installed under ui/node_modules.
pnpm ui:build

# 2. Restart the gateway so it re-resolves the UI root at boot
#    ({kind:"missing"} -> {kind:"resolved"}). Briefly interrupts Discord.
docker restart openclaw-openclaw-gateway-1
```

### Verification

```
$ docker exec openclaw-openclaw-gateway-1 ls /app/dist/control-ui/index.html   # present (2821 B)
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/healthz        # 200
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/               # 200
$ curl -s http://127.0.0.1:18789/ | head -c 40
<!doctype html> ... <title>OpenClaw Control</title>
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/assets/index-BS51oJri.js   # 200
```

No repo files changed for this fix (the artifact lives in gitignored `dist/`).

## Recurrence and prevention

This recurs on **any `dist/` wipe or regen** (`rm -rf dist`, a clean rebuild, fresh checkout): you must run **both** `pnpm ui:build` **and** `docker restart openclaw-openclaw-gateway-1` — building alone is not enough because of the boot-cached missing-state.

Options to make it self-healing (none implemented here; flagged for follow-up):

- **Deploy wrapper / build chain:** have the host deploy path run `pnpm ui:build` whenever `dist/control-ui/index.html` is absent (mirrors the existing `ensureControlUiAssetsBuilt` helper in `src/infra/control-ui-assets.ts:292`, which is not on the Docker boot path).
- **Per-request re-resolve:** allow `src/gateway/control-ui.ts` to re-resolve a `"missing"` root on demand (with a short negative cache) so a later `ui:build` is picked up without a restart. Would need care to avoid per-404 `existsSync` cost.

Both touch core/runtime behavior and would need the usual gates + owner review; for now the operational runbook above is the fix.

Recorded as item 6 in host project memory `project_known_issues.md`.

## Appendix — diagnosis recipes

```bash
# Are the assets present on host and in the container (bind mount)?
ls dist/control-ui/index.html
docker exec openclaw-openclaw-gateway-1 ls -la /app/dist/control-ui/index.html

# Is the gateway serving the UI or the 503?
curl -s -o /dev/null -w 'root %{http_code}\n' http://127.0.0.1:18789/
curl -s -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:18789/healthz

# Confirm a hashed bundle resolves (catches partial/stale builds)
asset=$(curl -s http://127.0.0.1:18789/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
curl -s -o /dev/null -w "asset %{http_code}\n" "http://127.0.0.1:18789$asset"
```
