# ConsentGate operator runbook

## Enable / disable

- **Enable:** Set `gateway.consentGate.enabled` to `true` in config. Default gated tools: exec, write, gateway, sessions_spawn, sessions_send, whatsapp_login, skills.install, system.run.
- **Disable:** Set `gateway.consentGate.enabled` to `false` (default). No consent checks run; all tools behave as before.
- **Observe-only:** With ConsentGate enabled, set `gateway.consentGate.observeOnly` to `true` (default). Decisions are logged (WAL) but execution is not blocked. Use to validate behavior before turning on enforce.

## Deny reason codes

When a gated tool or node command is denied, the response includes a `reasonCode`. Use it for diagnostics and runbooks.

| Code                           | Meaning                                   | Operator action                                                                                                           |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| CONSENT_NO_TOKEN               | No consent token in request               | Client must obtain a token via consent.issue (or Control UI) and send it (e.g. body.consentToken or params.consentToken). |
| CONSENT_TOKEN_NOT_FOUND        | Token id not in store                     | Token may be expired, revoked, or wrong id. Issue a new token.                                                            |
| CONSENT_TOKEN_ALREADY_CONSUMED | Token was already used (replay)           | Single-use only. Issue a new token per execution.                                                                         |
| CONSENT_TOKEN_REVOKED          | Token was revoked                         | Issue a new token; check if revoke was intentional.                                                                       |
| CONSENT_TOKEN_EXPIRED          | Token TTL exceeded                        | Issue a new token with sufficient TTL.                                                                                    |
| CONSENT_TOOL_MISMATCH          | Token was issued for a different tool     | Issue a token for the requested tool.                                                                                     |
| CONSENT_SESSION_MISMATCH       | Token session does not match request      | Use a token issued for this sessionKey.                                                                                   |
| CONSENT_CONTEXT_MISMATCH       | Request context hash does not match token | Token was issued for different args/context; re-issue for current request.                                                |
| CONSENT_TIER_VIOLATION         | Trust tier not allowed for this tool      | Check policy; issue token with correct tier or adjust tier–tool matrix.                                                   |
| CONSENT_UNAVAILABLE            | ConsentGate store or engine failed        | Fail closed. Check gateway logs and ConsentGate storage; restart gateway if needed.                                       |

## Break-glass (emergency bypass)

- ConsentGate has no built-in bypass in enforce mode: if enabled, gated operations require a valid token.
- To allow execution during an incident: disable ConsentGate (`gateway.consentGate.enabled: false`) and reload config (or restart gateway). Prefer revoking specific tokens or lifting quarantine instead of disabling entirely.
- Any change (disable, revoke, quarantine) should be audited and documented.

## Revoke and quarantine

- **Revoke by token:** Use ConsentGate API `consent.revoke({ jti })` to invalidate a single token.
- **Revoke by session:** Use `consent.bulkRevoke({ sessionKey })` to revoke all tokens for a session (e.g. after suspected compromise).
- **Quarantine:** Quarantine is implemented. Quarantined sessions cannot receive new tokens until quarantine is lifted. Use `POST /api/consent/quarantine/lift` with body `{ "sessionKey": "<sessionKey>" }` (gateway auth required).

## WAL and audit

- Decisions are written to the WAL (in-memory when no storage path; file-backed when `gateway.consentGate.storagePath` is set). Use `GET /api/consent/status?sessionKey=...&sinceMs=...` to inspect recent events (Control UI live mode or API).
- **Audit export (JSONL):** When durable storage is configured, `GET /api/consent/export?sinceMs=...&untilMs=...&limit=...&correlationId=...` returns WAL events as newline-delimited JSON (NDJSON) for SIEM or compliance. Requires gateway auth. Example: `curl -H "Authorization: Bearer <token>" "http://localhost:18789/api/consent/export?limit=500"`.
- **Enterprise audit stream:** Set `gateway.consentGate.audit.enabled: true` and `gateway.consentGate.audit.destination` to `"stdout"` or a file path. Every consent event is then written as JSONL to that destination (with optional `audit.redactSecrets: true`). Use for SIEM or compliance pipelines without calling the export API.
- **Metrics:** `GET /api/consent/metrics` returns a snapshot of consent counters (issues, consumes, revokes, denials by reason code, quarantine, fail-closed). Use for dashboards or alerting. Requires gateway auth.
- **Structured logs:** Each consent decision (issue, consume, deny, revoke) is logged as JSON by the `consentgate` subsystem so log aggregators can query by `eventType`, `reasonCode`, `sessionKey`, or `correlationId`.

## Enterprise ConsentGate

- **Enforce mode:** Set `gateway.consentGate.observeOnly: false` so that gated tools are blocked without a valid token. Use after validating behavior in observe-only mode.
- **Trust tier mapping:** Use `gateway.consentGate.trustTierDefault` and `gateway.consentGate.trustTierMapping` to map session key prefixes (e.g. `"telegram:"`, `"discord:"`) to tiers; combine with `tierToolMatrix` to restrict which tools each tier can use.
- **Audit:** Enable `gateway.consentGate.audit` (see above) for a continuous audit stream. ConsentGate does not replace exec approvals: exec approvals gate shell execution; ConsentGate gates high-risk tool invocations (exec, write, gateway, etc.) with tokens and WAL.

## Deny storm

If many requests are denied (e.g. CONSENT_NO_TOKEN):

1. Confirm whether clients are expected to send consent tokens (e.g. Control UI or automation).
2. If tokens are required and clients do not have them, either issue tokens (e.g. via UI) or temporarily use observe-only mode to unblock while fixing client integration.
3. Check WAL and metrics for reason-code distribution to target fixes.

## Multi-tenant behavior

- `tenantId` is present in WAL events and in status/export query parameters; you can filter by `tenantId` when calling `GET /api/consent/status` or `GET /api/consent/export`.
- Policy namespacing per tenant (e.g. separate tier–tool matrix or rate limits per tenant) is not yet enforced in the engine; all tenants share the same policy.
- Current tests do not exercise tenant isolation; treat multi-tenant deployment as best-effort isolation via `tenantId` filtering until explicit per-tenant policy is added.

## References

- [Enterprise ConsentGate implementation plan](/grants/enterprise-consentgate-implementation-plan)
- [Tokens review](/reference/tokens-review) for gateway vs consent token concepts.
