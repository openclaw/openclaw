---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Webhook ingress for wake and isolated agent runs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or changing webhook endpoints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Wiring external systems into OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Webhooks"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Webhooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway can expose a small HTTP webhook endpoint for external triggers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  hooks: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    token: "shared-secret",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    path: "/hooks",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hooks.token` is required when `hooks.enabled=true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hooks.path` defaults to `/hooks`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every request must include the hook token. Prefer headers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Authorization: Bearer <token>` (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `x-openclaw-token: <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `?token=<token>` (deprecated; logs a warning and will be removed in a future major release)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Endpoints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `POST /hooks/wake`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Payload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "text": "System line", "mode": "now" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `text` **required** (string): The description of the event (e.g., "New email received").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mode` optional (`now` | `next-heartbeat`): Whether to trigger an immediate heartbeat (default `now`) or wait for the next periodic check.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Effect:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enqueues a system event for the **main** session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `mode=now`, triggers an immediate heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `POST /hooks/agent`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Payload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "message": "Run this",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "Email",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "sessionKey": "hook:email:msg-123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "wakeMode": "now",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "deliver": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channel": "last",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "to": "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "model": "openai/gpt-5.2-mini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "thinking": "low",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "timeoutSeconds": 120（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message` **required** (string): The prompt or message for the agent to process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `name` optional (string): Human-readable name for the hook (e.g., "GitHub"), used as a prefix in session summaries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey` optional (string): The key used to identify the agent's session. Defaults to a random `hook:<uuid>`. Using a consistent key allows for a multi-turn conversation within the hook context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wakeMode` optional (`now` | `next-heartbeat`): Whether to trigger an immediate heartbeat (default `now`) or wait for the next periodic check.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deliver` optional (boolean): If `true`, the agent's response will be sent to the messaging channel. Defaults to `true`. Responses that are only heartbeat acknowledgments are automatically skipped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel` optional (string): The messaging channel for delivery. One of: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Defaults to `last`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `to` optional (string): The recipient identifier for the channel (e.g., phone number for WhatsApp/Signal, chat ID for Telegram, channel ID for Discord/Slack/Mattermost (plugin), conversation ID for MS Teams). Defaults to the last recipient in the main session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model` optional (string): Model override (e.g., `anthropic/claude-3-5-sonnet` or an alias). Must be in the allowed model list if restricted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thinking` optional (string): Thinking level override (e.g., `low`, `medium`, `high`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutSeconds` optional (number): Maximum duration for the agent run in seconds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Effect:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs an **isolated** agent turn (own session key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Always posts a summary into the **main** session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `wakeMode=now`, triggers an immediate heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `POST /hooks/<name>` (mapped)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Custom hook names are resolved via `hooks.mappings` (see configuration). A mapping can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
turn arbitrary payloads into `wake` or `agent` actions, with optional templates or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
code transforms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mapping options (summary):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hooks.presets: ["gmail"]` enables the built-in Gmail mapping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hooks.mappings` lets you define `match`, `action`, and templates in config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hooks.transformsDir` + `transform.module` loads a JS/TS module for custom logic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `match.source` to keep a generic ingest endpoint (payload-driven routing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TS transforms require a TS loader (e.g. `bun` or `tsx`) or precompiled `.js` at runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `deliver: true` + `channel`/`to` on mappings to route replies to a chat surface（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (`channel` defaults to `last` and falls back to WhatsApp).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowUnsafeExternalContent: true` disables the external content safety wrapper for that hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (dangerous; only for trusted internal sources).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw webhooks gmail setup` writes `hooks.gmail` config for `openclaw webhooks gmail run`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  See [Gmail Pub/Sub](/automation/gmail-pubsub) for the full Gmail watch flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Responses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `200` for `/hooks/wake`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `202` for `/hooks/agent` (async run started)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `401` on auth failure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `400` on invalid payload（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `413` on oversized payloads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST http://127.0.0.1:18789/hooks/wake \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Authorization: Bearer SECRET' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{"text":"New email received","mode":"now"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST http://127.0.0.1:18789/hooks/agent \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'x-openclaw-token: SECRET' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Use a different model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add `model` to the agent payload (or mapping) to override the model for that run:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST http://127.0.0.1:18789/hooks/agent \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'x-openclaw-token: SECRET' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you enforce `agents.defaults.models`, make sure the override model is included there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -X POST http://127.0.0.1:18789/hooks/gmail \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Authorization: Bearer SECRET' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep hook endpoints behind loopback, tailnet, or trusted reverse proxy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a dedicated hook token; do not reuse gateway auth tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid including sensitive raw payloads in webhook logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hook payloads are treated as untrusted and wrapped with safety boundaries by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  If you must disable this for a specific hook, set `allowUnsafeExternalContent: true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  in that hook's mapping (dangerous).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
