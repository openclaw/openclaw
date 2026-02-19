# ConsentGate threat model

This document lists invoke paths and consent bypass scenarios that ConsentGate is designed to prevent. See [Enterprise ConsentGate implementation plan](/grants/enterprise-consentgate-implementation-plan) for scope and architecture.

## Invoke paths in scope

1. **Gateway HTTP tool invoke**
   - Entry: `POST /tools/invoke`
   - Code: [src/gateway/tools-invoke-http.ts](src/gateway/tools-invoke-http.ts)
   - Risk: Caller can request execution of high-risk tools (exec, write, gateway, sessions\_\*, etc.) without user consent.
   - Mitigation: ConsentGate checks before `tool.execute(...)`. Gated tools require a valid consent token (jti) in the request; consume is single-use and context-bound.

2. **Node invoke (gateway → node)**
   - Entry: `node.invoke` server method (WebSocket/socket).
   - Code: [src/gateway/server-methods/nodes.ts](src/gateway/server-methods/nodes.ts)
   - Risk: High-risk node commands (e.g. `system.run`) can be forwarded without consent.
   - Mitigation: (Phase 2) Consent check before forwarding; consent metadata passed in invoke params.

3. **Node host execution**
   - Entry: Execution on the node host (e.g. `system.run`).
   - Code: [src/node-host/invoke.ts](src/node-host/invoke.ts)
   - Risk: Even if gateway is bypassed or buggy, host could execute gated commands without a validated consent envelope.
   - Mitigation: (Phase 2) Host validates consent envelope (integrity + replay/expiry) and rejects missing/invalid consent.

## Bypass scenarios (and mitigations)

| Scenario                                             | Mitigation                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Caller sends no token for gated tool                 | Enforce mode returns 403 with CONSENT_NO_TOKEN / TOKEN_NOT_FOUND.                                          |
| Caller replays same token twice                      | Second consume sees status=consumed; returns TOKEN_ALREADY_CONSUMED.                                       |
| Caller uses token for different tool/session/context | contextHash, tool, sessionKey, trustTier must match; otherwise CONSENT\_\*\_MISMATCH or TIER_VIOLATION.    |
| Token expired                                        | TTL check; CONSENT_TOKEN_EXPIRED.                                                                          |
| Token revoked                                        | status=revoked; CONSENT_TOKEN_REVOKED.                                                                     |
| ConsentGate process/store down                       | Fail closed: return 503 CONSENT_UNAVAILABLE so gated tools do not run.                                     |
| Bypass by calling a different endpoint               | Only documented invoke paths are instrumented; node path and host path (Phase 2) close other entry points. |
| Tier escalation                                      | trustTier in token and request must match; tier–tool matrix (Phase 3) deny-by-default.                     |

## Non-goals (out of scope for initial release)

- Replacing gateway auth or device pairing.
- Replacing exec approval UX (complements it).
- Protecting against compromise of the gateway process itself (Mode A is in-process; Mode B optional for stronger isolation).

## Approval and maintenance

- Threat model should be updated when new invoke paths or gated operations are added.
- Review as part of Phase 0 exit and before each major ConsentGate release.
