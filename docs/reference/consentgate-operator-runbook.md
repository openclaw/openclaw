# ConsentGate operator runbook

## Enable / disable

- **Enable:** Set `gateway.consentGate.enabled` to `true` in config. Default gated tools: exec, write, gateway, sessions_spawn, sessions_send, whatsapp_login, skills.install, system.run.
- **Disable:** Set `gateway.consentGate.enabled` to `false` (default). No consent checks run; all tools behave as before.
- **Observe-only:** With ConsentGate enabled, set `gateway.consentGate.observeOnly` to `true` (default). Decisions are logged (WAL) but execution is not blocked. Use to validate behavior before turning on enforce.

## Deny reason codes

When a gated tool or node command is denied, the response includes a `reasonCode`. Use it for diagnostics and runbooks.

| Code | Meaning | Operator action |
| ---- | ------- | ---------------- |
| CONSENT_NO_TOKEN | No consent token in request | Client must obtain a token via consent.issue (or Control UI) and send it (e.g. body.consentToken or params.consentToken). |
| CONSENT_TOKEN_NOT_FOUND | Token id not in store | Token may be expired, revoked, or wrong id. Issue a new token. |
| CONSENT_TOKEN_ALREADY_CONSUMED | Token was already used (replay) | Single-use only. Issue a new token per execution. |
| CONSENT_TOKEN_REVOKED | Token was revoked | Issue a new token; check if revoke was intentional. |
| CONSENT_TOKEN_EXPIRED | Token TTL exceeded | Issue a new token with sufficient TTL. |
| CONSENT_TOOL_MISMATCH | Token was issued for a different tool | Issue a token for the requested tool. |
| CONSENT_SESSION_MISMATCH | Token session does not match request | Use a token issued for this sessionKey. |
| CONSENT_CONTEXT_MISMATCH | Request context hash does not match token | Token was issued for different args/context; re-issue for current request. |
| CONSENT_TIER_VIOLATION | Trust tier not allowed for this tool | Check policy; issue token with correct tier or adjust tier–tool matrix. |
| CONSENT_UNAVAILABLE | ConsentGate store or engine failed | Fail closed. Check gateway logs and ConsentGate storage; restart gateway if needed. |

## Break-glass (emergency bypass)

- ConsentGate has no built-in bypass in enforce mode: if enabled, gated operations require a valid token.
- To allow execution during an incident: disable ConsentGate (`gateway.consentGate.enabled: false`) and reload config (or restart gateway). Prefer revoking specific tokens or lifting quarantine instead of disabling entirely.
- Any change (disable, revoke, quarantine) should be audited and documented.

## Revoke and quarantine

- **Revoke by token:** Use ConsentGate API `consent.revoke({ jti })` to invalidate a single token.
- **Revoke by session:** Use `consent.bulkRevoke({ sessionKey })` to revoke all tokens for a session (e.g. after suspected compromise).
- **Quarantine:** (Phase 3) When implemented, quarantined sessions cannot receive new tokens until quarantine is lifted via admin API or runbook.

## WAL and audit

- Decisions are written to the WAL (in-memory in default setup). Use `consent.status({ sessionKey, sinceMs })` to inspect recent events.
- For SIEM/compliance export, see enterprise plan Phase 4 (observability and audit).

## Deny storm

If many requests are denied (e.g. CONSENT_NO_TOKEN):

1. Confirm whether clients are expected to send consent tokens (e.g. Control UI or automation).
2. If tokens are required and clients do not have them, either issue tokens (e.g. via UI) or temporarily use observe-only mode to unblock while fixing client integration.
3. Check WAL and metrics for reason-code distribution to target fixes.

## References

- [Enterprise ConsentGate implementation plan](/grants/enterprise-consentgate-implementation-plan)
- [Tokens review](/reference/tokens-review) for gateway vs consent token concepts.
