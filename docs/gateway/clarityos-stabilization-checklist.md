# ClarityOS stabilization checklist (operator quick runbook)

Use this checklist before shipping a release that changes Control UI/ClarityOS behavior.

## 1) User-visible smoke checks

- Open Control UI and confirm dashboard loads (no blank screen/no fatal toast).
- Open **ClarityOS** tab and confirm status/summary/timeline render.
- Hard refresh while on `/clarityos`; confirm route resolves back to ClarityOS tab.
- Open **Sessions** tab; confirm session list renders and status/actions respond.
- Reconnect once (disconnect/reconnect flow); confirm no persistent auth/disconnect error loop.

## 2) Build/runtime integrity checks

- Build UI and verify manifest is generated:
  - `pnpm ui:build`
  - expect `dist/control-ui/asset-manifest.json`
- Validate provenance consistency:
  - `pnpm build:provenance`
  - expect `provenance-check: OK`
- Verify version/provenance route:
  - `GET /health/version` should include `version` and `ui_manifest_sha` (or fallback from runtime status).

## 3) Logs sanity checks

During startup, review logs for recurring errors (especially):

- auth failures/unauthorized loops
- provenance mismatch warnings
- manifest drift/missing asset warnings

Any repeat loop should block release until triaged.

## 4) Recommended targeted test gates

- `pnpm --dir ui exec vitest run --config vitest.node.config.ts`
- `pnpm vitest run src/infra/ui-asset-manifest.test.ts src/gateway/server.plugin-http-auth.test.ts`
- `pnpm vitest run src/gateway/session-utils.fs.test.ts`
