# @openclaw/genpark — GenPark Integration for OpenClaw

> **Status:** Feature proposal — ready for GenPark engineering review

This extension integrates [GenPark](https://genpark.ai) into [OpenClaw](https://github.com/openclaw/openclaw), the open-source personal AI assistant. It adds GenPark Circle as a first-class messaging channel and provides a Skill Marketplace search tool.

## Features

| Feature | Description |
|---------|-------------|
| **Circle Channel** | Receive and reply to GenPark Circle messages via webhooks |
| **Marketplace Search** | Agent tool to search GenPark's skill marketplace |
| **API Client** | Typed, retry-aware GenPark REST API client |
| **Rate-Limit Handling** | Automatic retry with exponential backoff on 429s |
| **Upgrade Prompts** | User-friendly prompts when hitting 403/429 errors |

## Architecture

```
GenPark Circle (Webhook) ──► OpenClaw Gateway ──► GenPark Channel Plugin
                                                      │
                                                      ├── handleInbound()  → session routing
                                                      ├── sendMessage()    → POST /circles/…
                                                      └── marketplace tool → GET /marketplace/…
```

## How to Integrate

### 1. Install the Extension

The extension lives at `extensions/genpark/` in the OpenClaw monorepo.

```bash
# From the openclaw root:
pnpm install
```

### 2. Configure

Add to `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    genpark: {
      genpark_api_token: "gp_your_api_token_here",
      circle_id: "your-circle-id",           // optional: default Circle to watch
      circle_webhook_secret: "whsec_...",     // optional: HMAC webhook verification
      marketplace_enabled: true               // default: true
    }
  }
}
```

### 3. Set Up Webhooks (for inbound messages)

Point your GenPark Circle webhook to:
```
POST https://<your-gateway>/api/channels/genpark/webhook
```

Payload format expected:
```json
{
  "event": "message.created",
  "data": {
    "id": "msg-uuid",
    "circleId": "circle-uuid",
    "threadId": "thread-uuid",
    "authorId": "user-uuid",
    "authorName": "User Display Name",
    "content": "Message text",
    "createdAt": "2026-03-26T10:00:00Z"
  },
  "signature": "hmac-sha256-hex"
}
```

### 4. Use the Marketplace Search Tool

Once configured, the agent can use the tool automatically:
```
User: Search for productivity skills on GenPark
Agent: [calls genpark_marketplace_search with query="productivity"]
```

## File Structure

```
extensions/genpark/
├── index.ts                 # Plugin entry point
├── setup-entry.ts           # Lifecycle: setup + health check + teardown
├── openclaw.plugin.json     # Config schema definition
├── package.json
├── README.md                # ← you are here
└── src/
    ├── api-client.ts        # Typed GenPark REST API client
    ├── api-client.test.ts   # API client unit tests
    ├── channel.ts           # Circle channel plugin (inbound/outbound)
    ├── channel.test.ts      # Channel plugin unit tests
    ├── marketplace.ts       # Skill Marketplace search tool
    └── runtime.ts           # Runtime hooks (tool registration, error handling)
```

## API Endpoints Used

> **⚠️ Note for GenPark Engineers:** These endpoints are modeled on expected patterns. Please verify/adjust to match the actual GenPark API.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/v1/users/me` | Token validation / health check |
| `GET` | `/v1/users/:id` | User profile lookup |
| `POST` | `/v1/circles/:id/threads` | Create new Circle thread |
| `GET` | `/v1/circles/:id/threads/:tid` | Get thread with messages |
| `POST` | `/v1/circles/:id/threads/:tid/messages` | Post a reply |
| `GET` | `/v1/marketplace/skills?q=...` | Search skill marketplace |

## Running Tests

```bash
# From the openclaw root:
npx vitest run extensions/genpark/src/channel.test.ts
npx vitest run extensions/genpark/src/api-client.test.ts

# Or all GenPark tests:
npx vitest run extensions/genpark/
```

## Integration Notes for GenPark Engineers

1. **Webhook signature verification** — The `verifyWebhookSignature()` function in `channel.ts` is a placeholder. Replace with actual HMAC-SHA256 verification using your webhook secret.

2. **Bot user ID** — The `handleInbound()` method filters out messages from `"openclaw-bot"`. Update this to match the actual bot user ID from your system.

3. **API base URL** — Defaults to `https://api.genpark.ai/v1`. Override via the `GenParkClient` constructor if your API lives elsewhere.

4. **Rate limits** — The client retries up to 3 times on 429 responses with exponential backoff. Adjust `MAX_RETRIES` and `RETRY_DELAY_MS` in `api-client.ts` if needed.

5. **Tool registration** — The `genpark_marketplace_search` tool is registered via `runtime.registerTool()`. Ensure this matches your OpenClaw runtime's tool registration API.

## License

MIT — same as OpenClaw.
