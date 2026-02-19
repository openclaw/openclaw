# How Tokens Work in OpenClaw — Review

This document reviews all token types: where they come from, where they are stored, how they are validated or refreshed, and how they flow through the system.

---

## 1. Gateway auth (shared secret)

**Purpose:** Authenticate clients (CLI, control UI, nodes) to the gateway (WebSocket and HTTP).

**Token type:** Single shared secret — either a **token** or a **password** (configurable mode).

**Source and config:**

- From config: `gateway.auth.mode` = `"token"` or `"password"`; `gateway.auth.token` or `gateway.auth.password`.
- From env: `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD`.
- Resolved in [src/gateway/auth.ts](src/gateway/auth.ts) via `resolveGatewayAuth()`.

**Flow:**

- Client sends token (or password) in the WebSocket connect params (`auth.token` or `auth.password`) or in HTTP `Authorization: Bearer <token>` (see [src/gateway/http-utils.ts](src/gateway/http-utils.ts) `getBearerToken()`).
- Gateway compares with resolved auth using constant-time compare (`safeEqualSecret()`).
- No expiry; no refresh. Rotate by changing config and updating clients.

**Storage:** Gateway side: in memory from config/env (not written to disk by the gateway). Client side: e.g. control UI settings, CLI config, or env.

**Relevant code:** `authorizeGatewayConnect()` in [src/gateway/auth.ts](src/gateway/auth.ts); [src/gateway/tools-invoke-http.ts](src/gateway/tools-invoke-http.ts) (Bearer for HTTP); WebSocket connect handling in [src/gateway/server/ws-connection/message-handler.ts](src/gateway/server/ws-connection/message-handler.ts).

---

## 2. Device pairing tokens (per-device, per-role)

**Purpose:** Let a specific device (e.g. iOS app) connect with a scoped token instead of the shared gateway secret. One device can be paired and get its own token; revocable without changing the shared secret.

**Token type:** Opaque token per device and role (e.g. `operator`), with scopes (e.g. `operator.read`). Generated with high entropy; verified with constant-time compare.

**Source:** Issued by the gateway when a device pairs (after successful shared-secret auth). Stored in device-pairing state under `~/.openclaw/` (or `OPENCLAW_STATE_DIR`).

**Flow:**

- Client connects with `auth.token` + `device` (deviceId). Gateway first accepts if shared-secret matches, then can issue a device token for that device/role.
- Later, client can connect with **only** the device token (no shared secret); gateway calls `verifyDeviceToken()` in [src/infra/device-pairing.ts](src/infra/device-pairing.ts).
- Device tokens can be revoked (`revokedAtMs`); state is persisted.

**Storage:** Gateway: `~/.openclaw/` device-pairing state (paired devices and their tokens). Client: stores the token it received at pairing.

**Relevant code:** [src/infra/device-pairing.ts](src/infra/device-pairing.ts) (`verifyDeviceToken`, `ensureDeviceToken`, revoke); [src/gateway/server/ws-connection/message-handler.ts](src/gateway/server/ws-connection/message-handler.ts) (device-token auth path).

---

## 3. OAuth provider credentials (access + refresh + expires)

**Purpose:** Authenticate to LLM providers that use OAuth (e.g. OpenAI Codex, Qwen Portal, Chutes, Google Antigravity, Gemini). Access token is used for API calls; refresh token is used to get a new access token when it expires.

**Token types:**

- **Access token:** Short-lived bearer token sent to the provider API.
- **Refresh token:** Long-lived; used only with the provider’s token endpoint to obtain a new access (and sometimes new refresh) token.
- **Expires:** Timestamp (ms) when the current access token is considered expired.

**Source:** From each provider’s OAuth (or setup-token) flow:

- User runs e.g. `openclaw models auth login --provider google-antigravity`.
- Plugin runs OAuth (authorize URL → callback → code exchange). Exchange uses **client ID + client secret** (provider-specific; see below).
- Result: `{ access, refresh, expires }` (+ optional `email`, `projectId`, etc.). Returned via `buildOauthProviderAuthResult()` in [src/plugin-sdk/provider-auth-result.ts](src/plugin-sdk/provider-auth-result.ts).

**Storage:**

- **Canonical store:** `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (auth profile store). Credentials are keyed by profile (e.g. `google-antigravity:user@example.com`).
- **Runtime sync for Pi/agents:** `~/.openclaw/agents/<agentId>/agent/auth.json` is written from auth-profiles by [src/agents/pi-auth-json.ts](src/agents/pi-auth-json.ts) so the coding agent can read OAuth credentials. Format: `type: "oauth"`, `access`, `refresh`, `expires`.

**Refresh flow:**

- When making a provider request, the runtime checks `expires`. If the access token is expired (or missing), it uses the **refresh token** to call the provider’s token endpoint (`grant_type=refresh_token`).
- New `access` (and sometimes new `refresh`) is written back to the auth profile store. Implementations are per-provider (e.g. [src/providers/qwen-portal-oauth.ts](src/providers/qwen-portal-oauth.ts), [src/agents/chutes-oauth.ts](src/agents/chutes-oauth.ts)).
- No user interaction needed for refresh; it is automatic until refresh fails (then user must re-login).

**Important:** The **client ID and client secret** used in the OAuth **code exchange** and (if applicable) **refresh** are **not** the same as the access/refresh tokens:

- **Client ID + secret:** Identify the _application_ to the OAuth provider. They are required only at login (and possibly refresh). They must **never** be committed; they should come from env or a secure secret store.
- **Access + refresh:** _User_ credentials; stored in auth-profiles.json and auth.json as above.

---

## 4. Google Antigravity OAuth (extension) — and the leak

**Purpose:** Let users log in to Google Antigravity (Cloud Code Assist) so OpenClaw can use that provider. Same OAuth pattern as above: authorize → callback → code exchange → store access/refresh/expires.

**Where the leak was:** In [extensions/google-antigravity-auth/index.ts](extensions/google-antigravity-auth/index.ts), the **OAuth client ID** and **client secret** (Google Cloud OAuth 2.0 credentials) were **hardcoded** as base64 strings. Those values identify the _app_ to Google and must be kept secret.

**How Antigravity tokens work:**

- **At login time:** Extension builds auth URL with `client_id`, starts local callback server or asks user to paste redirect URL, then exchanges the code at `https://oauth2.googleapis.com/token` using `client_id` + `client_secret` + `code` + `redirect_uri` + PKCE verifier.
- **Result:** `access_token`, `refresh_token`, `expires_in` returned by Google. These are passed to `buildOauthProviderAuthResult()` and end up in auth-profiles.json (and auth.json) as in section 3.
- **At runtime:** Only **access** and **refresh** (and **expires**) are used for API calls and refresh. The **client_id** and **client_secret** are **not** stored in auth-profiles; they are only needed for the initial exchange (and, for some providers, for refresh). So:
  - **Remove** client_id and client_secret from the repo entirely.
  - **Load** them at runtime from environment variables (e.g. `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_ID`, `GOOGLE_ANTIGRAVITY_OAUTH_CLIENT_SECRET`) when the user runs the Antigravity login flow.
  - **Revoke** the leaked credentials in Google Cloud Console and create new ones if they were ever committed or pushed.

**Summary:** Antigravity uses the same “OAuth provider credentials” model as section 3; the only mistake was putting the **app** credentials (client id/secret) in source. User tokens (access/refresh) were never in that file.

---

## 5. Other tokens (brief)

- **Hooks:** `gateway.hooks.token` (or similar) — shared secret for incoming webhook calls (e.g. wake). Sent as `Authorization: Bearer <token>` or query param. Validated by gateway; no refresh.
- **Cron webhook:** Similar bearer token for cron-triggered webhooks.
- **Channel tokens:** e.g. Discord bot token, Telegram bot token — stored in config/credentials; used by channel adapters to connect to the platform. Not OAuth access/refresh; usually long-lived and rotated manually.
- **Exec approval:** Not a “token” in the same sense; approval is requested and resolved via socket or UI; no persistent token stored for exec.

---

## 6. ConsentGuard / consent tokens (design only)

In the ConsentGuard design (docs/grants and demo UI), **consent tokens** are a separate concept:

- **Purpose:** Gate high-risk tool execution: each tool call (or class of call) requires a consent token that was issued for that context (tool, trust tier, session).
- **Lifecycle:** Issue (with context hash) → consume (single-use, atomic) → or revoke. Optional TTL and idempotent issuance for heartbeat.
- **Storage:** WAL + optional persistent store (e.g. DynamoDB). Not implemented in the current OpenClaw codebase; the grant docs and React demo describe the intended behavior.

---

## 7. Summary table

| Token kind             | Stored where                              | Who validates / uses       | Refresh / expiry               |
| ---------------------- | ----------------------------------------- | -------------------------- | ------------------------------ |
| Gateway auth           | Config / env (server); UI/config (client) | Gateway auth.ts            | None; rotate manually          |
| Device pairing         | ~/.openclaw device state                  | device-pairing.ts          | Revocable; no auto-refresh     |
| OAuth access/refresh   | auth-profiles.json, auth.json             | Provider runtime           | Auto-refresh via refresh token |
| OAuth client id/secret | Must be env or secret store (not repo)    | Used only at login/refresh | N/A — app credentials          |
| Hooks / cron webhook   | Config                                    | Gateway hook handlers      | None                           |
| Channel (Discord etc.) | Config / credentials                      | Channel adapters           | Manual rotate                  |

This review should be enough to reason about token flow when fixing the Antigravity leak (use env for client id/secret), adding new OAuth providers, or implementing ConsentGuard-style consent tokens.
