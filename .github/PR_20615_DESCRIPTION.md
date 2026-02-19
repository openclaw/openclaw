# PR #20615 – Updated description (paste into GitHub)

## Branch sync (do first)

1. Ensure the branch that backs PR #20615 includes the six improvements commits: Antigravity OAuth env, file store+WAL, HTTP API+live UI, metrics, policy+quarantine, grants+runbook.
2. If the PR currently points at `funding-consent-evaluated-fix`: either push your local `funding` branch and change the PR to use it, or merge/rebase `funding` into `funding-consent-evaluated-fix` and push.
3. Then paste the description below into the PR on GitHub.

---

## Description (paste below into PR)

---

## Summary

- **Problem:** No unified consent enforcement layer existed across OpenClaw's high-risk tool invocation paths — gated tools like `exec`, `write`, `sessions_spawn`, etc. could be called without any explicit per-action authorization.
- **Why it matters:** Prompt injection, session bleed, and supply-chain attacks via skills could trigger privileged tool execution silently; there was no audit trail for authorization decisions.
- **What changed:** Added ConsentGate — a consent-token engine with single-use, context-bound tokens, optional durable token store and file-backed WAL, HTTP API for status/revoke/metrics/export/quarantine lift, Control UI live mode, trust-tier and rate-limit policy, anomaly quarantine and lift API, and metrics/structured logging. Integrated at HTTP `/tools/invoke`, `node.invoke`, and node-host `system.run`. Google Antigravity OAuth now reads client id/secret from env (no hardcoded credentials). Grant application drafts and operator runbook added.
- **What did NOT change:** Existing gateway auth, device pairing, exec approval UX, and tool deny lists are untouched. ConsentGate defaults to disabled (`enabled: false`) and observe-only (`observeOnly: true`) when enabled.

## Change Type

- Feature
- Security hardening
- Docs

## Scope

- Gateway / orchestration
- Skills / tool execution
- Auth / tokens
- Memory / storage
- API / contracts
- UI / DX

## User-visible / Behavior Changes

- New config keys: `gateway.consentGate.enabled`, `gateway.consentGate.gatedTools`, `gateway.consentGate.observeOnly`, `gateway.consentGate.storagePath`, `trustTierDefault`, `trustTierMapping`, `tierToolMatrix`, `rateLimit` (maxOpsPerWindow, windowMs), `anomaly` (weightsByReason, quarantineThreshold, cascadeRevokeOnQuarantine).
- When `enabled: true` and `observeOnly: false`, gated tool calls without a valid consent token return HTTP 403 with `type: "consent_denied"` and a `reasonCode`.
- When `storagePath` is set: durable file-backed token store and file-backed WAL; `GET /api/consent/export` returns WAL events as NDJSON.
- HTTP API (gateway auth required): `GET /api/consent/status`, `POST /api/consent/revoke`, `GET /api/consent/metrics`, `GET /api/consent/export`, `POST /api/consent/quarantine/lift`.
- Control UI consent demo has a live mode (calls real API, supports revoke and quarantine lift).
- Google Antigravity OAuth: set `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_ID` and `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_SECRET` in env; no hardcoded credentials in repo.
- All defaults preserve existing behavior: disabled by default, observe-only when enabled.

## Security Impact

- New permissions/capabilities? **Yes** — ConsentGate adds consent-token issue/consume/revoke and quarantine lift. In observe-only mode (default), no execution is blocked. In enforce mode, gated tools require a valid token.
- Secrets/tokens handling changed? **Yes** — New consent token type (jti, contextHash, trustTier, sessionKey, TTL). Tokens can be in-memory (default) or file-backed when `storagePath` is set. Google Antigravity OAuth credentials from env only.
- New/changed network calls? **No** — All ConsentGate checks are in-process (Mode A).
- Command/tool execution surface changed? **Yes** — In enforce mode, gated tool calls are blocked without a consent token; node-host validates consent envelope for `system.run`. Mitigation: defaults to observe-only; `enabled: false` is a complete no-op.
- Data access scope changed? **No**

## Human Verification (required)

- **Verified scenarios:** Observe-only mode logs without blocking; enforce mode blocks on missing/expired/replayed/context-mismatched tokens; no-op when `enabled: false`. Durable WAL/export verified with `storagePath` set in tests.
- **Edge cases checked:** Token expiry, replay (single-use atomicity), context hash mismatch.
- **What you did NOT verify:** Mode B / out-of-process deployment; node-host consent envelope e2e under real node pairing; multi-tenant isolation in tests.

## Failure Recovery (if this breaks)

- **Disable quickly:** Set `gateway.consentGate.enabled: false` and reload/restart gateway.
- **Restore:** Remove or set `gateway.consentGate.enabled: false` in config.
- **Watch for:** Legitimate tool calls returning 403 `CONSENT_NO_TOKEN` when enforce is on but clients do not send tokens; use `observeOnly: true` during rollout.
