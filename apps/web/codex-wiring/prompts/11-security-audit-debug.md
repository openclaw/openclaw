# Ticket 11 — Security, Audit, Debug Wiring

## Goal
Wire security and debug surfaces to real gateway RPCs.

## Background
- Security RPCs are implemented in gateway (`security.*`, `tokens.*`, `audit.query`).
- Debug screens in `apps/web` are mock‑backed.

## Scope
- Unlock screen uses `security.getState` + `security.unlock` + `security.lock`.
- Two‑factor setup/verify/disable flows wired to gateway.
- Tokens and audit log wired to gateway.
- Debug console uses real RPC calls and `logs.tail`.

## Requirements
1. **Security flows**
   - Password setup/change/disable.
   - 2FA setup/verify/disable.
2. **Tokens**
   - List/create/revoke tokens via `tokens.*`.
3. **Audit**
   - Query audit log via `audit.query`.
4. **Debug**
   - Real health/status data.
   - RPC runner executes gateway methods.
   - Log viewer uses `logs.tail`.

## Fixed Decisions (Do Not Re‑decide)
- Tokens use `tokens.list`, `tokens.create`, `tokens.revoke` with scopes from gateway schema.
- Audit uses `audit.query` with paging (`limit`, `offset`) and filters (`category`, `severity`, `action`).
- Logs use `logs.tail` with `cursor`, `limit`, `maxBytes`.

## Required Decisions (Blockers)
1. **Debug RPC runner**
   - **Question:** should the debug runner allow **all** gateway methods or a limited allowlist?
   - **Allowed answers:** `all-methods` or `allowlist`
   - **Required response format:** single literal from list (if `allowlist`, include the list).
2. **Security history source**
   - **Question:** is `security.getHistory` authoritative for 2FA history, or should audit log be used?
   - **Allowed answers:** `security.getHistory` or `audit.query`
   - **Required response format:** single literal from list.

## Files to Touch (expected)
- `apps/web/src/features/security/*`
- `apps/web/src/routes/unlock/*`
- `apps/web/src/routes/debug/*`
- `apps/web/src/lib/api/gateway-client.ts` (if needed)
- `apps/web/src/features/security/lib/security-api.ts`

## Acceptance Criteria
- Security flows function end‑to‑end.
- Token creation returns a new token and list updates.
- Audit log shows real gateway entries.
- Debug console runs real RPCs and log tail.

## Testing
- Manual: unlock flow; token create/revoke; audit query; log tail.
