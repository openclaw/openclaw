# Live Operationalization Checklist — Fleet Capability Contract v1

**Audience:** Squiddy / PeeWee (operators on `fresh-squiddy`)
**Author:** build architect (read-only; no live mutations performed)
**Target build:** OpenClaw `2026.5.31` (commit `0e11dc6`) — main containing merged PR #1
**Current on host:** OpenClaw `2026.5.27` (commit `27ae826`) — does NOT include `agents capabilities`

## Operational blockers this checklist resolves

- **B1 — stale/invalid live config** at `/root/.openclaw/openclaw.json`
  - `channels.telegram.streaming` / `channels.discord.streaming` must be objects (legacy scalar/flag keys)
  - retired/legacy model refs under `agents`
  - validation fails, so the capability report cannot run
- **B2 — installed binary predates PR #1**
  - merged in repo main (`0e11dc6`) but host `openclaw` is `2026.5.27`; `agents capabilities` is unrecognized

## Guardrails (apply to every phase)

- Never print secret **values**. When inspecting config, extract **keys only** (see safe-diff helper below); never `cat` the whole file into shared logs.
- No write/mutation outside the explicitly **approval-gated** Phase 1.
- Do not restart the gateway unless explicitly approved in the active window.
- Take the Phase 0 backups **before** any Phase 1 step. Phase 1 is blocked until Phase 0 artifacts exist.

### Safe-diff helper (keys only, no values)

```bash
# Prints the JSON key paths present in the config WITHOUT any values.
node -e 'const o=require("/root/.openclaw/openclaw.json");
const w=(v,p="")=>{if(v&&typeof v=="object"&&!Array.isArray(v))for(const k of Object.keys(v))w(v[k],p?`${p}.${k}`:k);else console.log(p)};
w(o)' | sort
```

---

## Phase 0 — backup / read-only (no approval needed; produces evidence)

> Goal: capture current state, prove the blockers, and pin the exact migration + update paths. **Zero writes to live config or binary.**

**0.1 — Record installed OpenClaw version + path**

```bash
command -v openclaw                  # resolved path
openclaw --version                   # expect: 2026.5.27 (27ae826)
readlink -f "$(command -v openclaw)" # real target (npm shim vs binary)
```

Save to `phase0/installed-version.txt`.

**0.2 — Back up the live config (read-only copy)**

```bash
mkdir -p /root/.openclaw/_backups
ts=$(date -u +%Y%m%dT%H%M%SZ)
cp -p /root/.openclaw/openclaw.json /root/.openclaw/_backups/openclaw.json.$ts.bak
sha256sum /root/.openclaw/openclaw.json /root/.openclaw/_backups/openclaw.json.$ts.bak
```

Record `$ts` and both hashes in `phase0/backup-manifest.txt`. **This is a copy, not an edit — permitted in Phase 0.** Confirm the two hashes match.

**0.3 — Run config validation read-only; save output**

```bash
openclaw config validate > phase0/config-validate.txt 2>&1 || true
```

> `config validate` is read-only and runs even on invalid config. Expected failures: `channels.telegram.streaming: must be object`, `channels.discord.streaming: must be object`, plus legacy/retired-model-ref notices. Confirm the saved file contains **no** secret values before sharing.

**0.4 — Identify exact schema migrations (no secrets)**
Use the safe-diff helper to confirm which legacy keys are present, then map each to its modern form:

| Legacy key (telegram/discord)          | Modern target                            |
| -------------------------------------- | ---------------------------------------- |
| `channels.<ch>.streamMode`             | `channels.<ch>.streaming.mode`           |
| `channels.<ch>.streaming` (scalar)     | `channels.<ch>.streaming.mode`           |
| `channels.<ch>.chunkMode`              | `channels.<ch>.streaming.chunkMode`      |
| `channels.<ch>.draftChunk`             | `channels.<ch>.streaming.preview.chunk`  |
| `channels.<ch>.blockStreaming`         | `channels.<ch>.streaming.block.enabled`  |
| `channels.<ch>.blockStreamingCoalesce` | `channels.<ch>.streaming.block.coalesce` |

For retired model refs: list the offending refs only (keys/values are model ids, **not** secrets):

```bash
node -e 'const o=require("/root/.openclaw/openclaw.json");
const ids=new Set();const a=o.agents||{};
(a.list||[]).forEach(x=>{if(x.model)ids.add(JSON.stringify(x.model))});
if(a.defaults&&a.defaults.model)ids.add(JSON.stringify(a.defaults.model));
console.log([...ids].join("\n"))' > phase0/model-refs.txt
```

Cross-check each ref in `phase0/model-refs.txt` against the current bundled catalog (`openclaw models list` on the **updated** build, or the PR build's catalog) and note the 1:1 replacement for each retired ref. Save the mapping to `phase0/model-migration-map.txt`.

**0.5 — Identify the exact update/install path (2026.5.27 → 2026.5.31 / `0e11dc6`)**
Detect how `openclaw` was installed, then pin the matching update command (do **not** run it yet):

```bash
# npm global?
npm ls -g --depth=0 2>/dev/null | grep -i openclaw
# pipx / pip?
pipx list 2>/dev/null | grep -i openclaw; pip show openclaw 2>/dev/null | head -3
# standalone binary / curl installer?
readlink -f "$(command -v openclaw)"; ls -l "$(command -v openclaw)"
```

Record the detected method in `phase0/install-method.txt` and the corresponding **proposed** Phase 1 command:

- **npm global:** `npm install -g openclaw@2026.5.31` (or the registry tag matching `0e11dc6`)
- **from source (repo main):** build/install from `MoonRay305/openclaw` at `0e11dc6` per repo build instructions, then relink the `openclaw` shim
- **curl/standalone installer:** re-run the official installer pinned to `2026.5.31`

> Confirm the chosen artifact actually contains the command before approving Phase 1: on a scratch path, `openclaw agents --help` must list `capabilities` and `openclaw agents capabilities --help` must succeed.

**Phase 0 exit criteria:** `installed-version.txt`, `backup-manifest.txt` (hashes match), `config-validate.txt`, `model-migration-map.txt`, and `install-method.txt` all saved; migration + update paths pinned. **Stop and request approval.**

---

## Phase 1 — approval-gated writes (do NOT proceed without explicit go)

> Each step is a mutation. Requires Phase 0 artifacts present and explicit approval. Gateway is **not** restarted here unless separately approved.

**1.1 — Update/install OpenClaw to merged main (`2026.5.31` / `0e11dc6`)**
Run the command pinned in `phase0/install-method.txt`. Then verify:

```bash
openclaw --version                         # expect 2026.5.31 (0e11dc6) or later
openclaw agents --help | grep -i capabilities
openclaw agents capabilities --help        # must succeed
```

Resolves **B2**.

**1.2 — Migrate config schema safely (work from the backup, not blind)**

- Operate on a working copy: `cp /root/.openclaw/_backups/openclaw.json.$ts.bak /root/.openclaw/_backups/openclaw.migrated.json`.
- Apply the migrations from `phase0/model-migration-map.txt` and the streaming-key table to the **working copy** (preferred: OpenClaw's own migration, `openclaw doctor --fix`, pointed at the config once the binary is updated; alternative: hand-edit per the table). Either way, **review the diff as key-paths only** (safe-diff helper) before swapping into place.
- Swap into place only after validation passes on the working copy (next step).
  Resolves **B1**.

**1.3 — Validate the migrated config (read-only check before swap)**

```bash
OPENCLAW_CONFIG_PATH=/root/.openclaw/_backups/openclaw.migrated.json openclaw config validate
```

Must report valid. Only then move it into place:

```bash
cp -p /root/.openclaw/openclaw.json /root/.openclaw/_backups/openclaw.json.$ts.pre-swap.bak
mv /root/.openclaw/_backups/openclaw.migrated.json /root/.openclaw/openclaw.json
openclaw config validate    # confirm live path now valid
```

**1.4 — Gateway:** leave running as-is. **Do not restart** unless explicitly approved. If approved, record start/stop timestamps for the rollback window.

**Phase 1 exit criteria:** binary reports `0e11dc6`+ and lists `capabilities`; `openclaw config validate` passes on the live path; pre-swap backup retained.

---

## Phase 2 — read-only proof (no further writes)

```bash
mkdir -p phase2
ts=$(date -u +%Y%m%dT%H%M%SZ)
openclaw agents capabilities --json     > phase2/capabilities.$ts.json
openclaw agents capabilities --markdown > phase2/capabilities.$ts.md
```

**2.1 / 2.2 — run JSON + Markdown** (above).
**2.3 — timestamped reports** saved under `phase2/`.
**2.4 — canary-scan for secret leakage** (must be 0 hits):

```bash
grep -REIn 'sk-[A-Za-z0-9]{10,}|xox[bp]-|ghp_[A-Za-z0-9]|AKIA[0-9A-Z]{16}|-----BEGIN|bearer [A-Za-z0-9]' phase2/ | wc -l
```

**2.5 — report red/yellow/green by agent:** read `rollup` plus each `profiles[].agentId` → `status`, and list any `red`/`yellow` `reason` codes (e.g. `provider_credentials_missing`, `delegation_credentials_missing`, `tools_unconfigured`). Expected live fleet: 5 agents (`main, harvey, donna, ghost, bob`); since `agents.defaults.subagents.model` is unset, delegation resolves via each agent's primary model (handled by the merged fix).

**Phase 2 exit criteria:** both reports saved + timestamped, canary = 0, per-agent status summarized.

---

## Rollback (any phase that performed a write)

Trigger if validation fails, the command misbehaves, or on operator call.

**R1 — restore config**

```bash
cp -p /root/.openclaw/_backups/openclaw.json.$ts.bak /root/.openclaw/openclaw.json
sha256sum /root/.openclaw/openclaw.json   # must match phase0/backup-manifest.txt original hash
openclaw config validate || true          # back to known prior state (may be the prior invalid state)
```

**R2 — restore the prior OpenClaw binary/version**

- **npm global:** `npm install -g openclaw@2026.5.27` (the pre-change version from `phase0/installed-version.txt`).
- **standalone/curl:** reinstall the previously recorded version, or restore the saved binary/symlink target captured in `phase0/installed-version.txt`.
- Verify: `openclaw --version` reports `2026.5.27 (27ae826)`.

**R3 — gateway**

- Restart **only if** it was explicitly restarted during the approved window; otherwise leave it untouched. Use the start/stop timestamps recorded in step 1.4.

**Rollback exit criteria:** config hash matches the Phase 0 original; binary back to `27ae826`; gateway state matches pre-window state.

---

## Notes / explicit non-actions in this deliverable

- No live mutations were performed producing this checklist.
- `openclaw doctor --fix` was **not** run; `/root/.openclaw/openclaw.json` was **not** modified; the gateway was **not** restarted; no binary was installed/updated; no credentials/secrets were touched.
- All secret handling in the checklist is presence/keys-only; the capability command itself renders status only and never emits secret values.
