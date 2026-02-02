# Ticket 04 — Channels + Pairing + OAuth Wiring

## Goal
Wire channel configuration to gateway RPCs, including WhatsApp pairing and OAuth flows, following Opus auth guidance.

## Background
- Legacy UI uses `web.login.start` / `web.login.wait` for WhatsApp.
- Opus auth plan: `apps/web/docs/plans/2026-02-01-auth-oauth-pairing-secrets-and-errors.md`.
- Channel settings UI exists in `components/domain/config/channels/*` but lacks pairing/OAuth wiring.

## Scope
- Use `channels.status` and `channels.logout` for status + logout.
- Add WhatsApp pairing flow (QR code) using gateway RPCs.
- Add OAuth/pairing flows for providers/channels per Opus plan.

## Requirements
1. **WhatsApp pairing**
   - `web.login.start` → display QR data URL.
   - `web.login.wait` → poll/wait for connection.
2. **OAuth flows**
   - Gateway‑side OAuth endpoints for providers/channels (new RPCs).
   - UI supports headless gateway fallback pairing.
3. **Secrets UX**
   - Follow Opus copy + error handling for secret fields and retries.

## Fixed Decisions (Do Not Re‑decide)
- WhatsApp pairing uses **legacy** RPCs:
  - `web.login.start` (returns QR data URL)
  - `web.login.wait` (wait/poll until connected; update channel status)
- Channel status/logout use `channels.status` + `channels.logout` only.

## Required Decisions (Blockers)
Add explicit choices here before implementation:
1. **OAuth RPC contract**
   - **Question:** which gateway RPCs will power OAuth?
   - **Allowed answers (pick one set):**
     - `auth.oauth.start` / `auth.oauth.status` / `auth.oauth.finish`
     - `oauth.start` / `oauth.status` / `oauth.finish`
   - **Required response format:** table with `method`, `params`, `result` fields.
2. **OAuth redirect strategy**
   - **Question:** how does UI receive the auth code?
   - **Allowed answers:** `popup + postMessage`, `new-tab + polling`, `same-tab + hash`
   - **Required response format:** single literal from list.
3. **Nostr support**
   - **Question:** keep Nostr UI or remove it?
   - **Allowed answers:** `keep-and-implement-http-endpoints` or `remove-ui`
   - **Required response format:** single literal from list.

## Files to Touch (expected)
- `apps/web/src/components/domain/config/ChannelConfigConnected.tsx`
- `apps/web/src/components/domain/config/channels/*`
- `apps/web/src/hooks/mutations/useConfigMutations.ts`

## New/Changed RPCs Needed
- `web.login.start`, `web.login.wait` (already in legacy UI)
- `auth.oauth.start`, `auth.oauth.status`, `auth.oauth.finish` (proposed)
- Optional `auth.pairing.start` for headless pairing

## Acceptance Criteria
- WhatsApp channel can be paired via QR in `apps/web`.
- OAuth providers can be connected without leaving the UI (headless fallback supported).
- Clear error states on auth failure.

## Testing
- Manual: test WhatsApp pairing and channel status update.
- Manual: test OAuth flow in local + headless gateway setup.
