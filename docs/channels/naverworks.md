---
summary: "NAVER WORKS plugin setup for DM-first inbound routing"
title: "NAVER WORKS"
---

# NAVER WORKS (plugin)

Status: **phase 3 (DM-first inbound + outbound text + media delivery)**.

Current phase focuses on:

- webhook intake for NAVER WORKS events
- DM-only handling (non-direct events are ignored)
- deterministic agent routing by `peer` and optional `teamId`
- outbound text + media URL delivery to NAVER WORKS DM with static token or JWT-based service-account auth

## Install

```bash
openclaw plugins install @openclaw/naverworks
```

Local checkout:

```bash
openclaw plugins install ./extensions/naverworks
```

## Config example

```json5
{
  channels: {
    naverworks: {
      enabled: true,
      webhookPath: "/naverworks/events",
      dmPolicy: "allowlist",
      allowFrom: ["user-U123", "user-U456"],
      strictBinding: true, // default: true (drop messages without a matching binding)
      botSecret: "your-bot-secret", // optional but strongly recommended for webhook signature verification
      botId: "your-bot-id",

      // Option A) static token (manual management)
      accessToken: "xoxb-your-worksmobile-token",

      // Option B) JWT service-account auth (recommended)
      clientId: "your-client-id",
      clientSecret: "your-client-secret",
      serviceAccount: "serviceaccount@example.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
      scope: "bot", // optional (default: bot)
      tokenUrl: "https://auth.worksmobile.com/oauth2/v2.0/token", // optional
      jwtIssuer: "your-jwt-issuer", // optional (default: clientId)

      apiBaseUrl: "https://www.worksapis.com/v1.0", // optional
      markdownMode: "auto-flex", // optional: auto-flex | plain

      autoThinking: {
        enabled: true,
        defaultLevel: "medium", // optional fallback when no keyword matches
        lowKeywords: ["요약", "번역", "맞춤법"],
        highKeywords: ["분석", "디버깅", "비교", "설계"],
      },

      statusStickers: {
        enabled: true,
        received: { packageId: "789", stickerId: "10855" },
        processing: { packageId: "534", stickerId: "2429" },
        failed: { packageId: "1", stickerId: "3" },
      },
    },
  },
  bindings: [
    {
      agentId: "nw-u123",
      match: {
        channel: "naverworks",
        teamId: "workspace-A",
        peer: { kind: "direct", id: "user-U123" },
      },
    },
  ],
}
```

## Notes

- Non-direct events are ignored in phase 1 by design.
- Inbound media-only events are supported for direct messages. The plugin accepts image/audio/file payloads when a media URL is present, and forwards media metadata to the agent context.
- Outbound media replies are sent when the agent returns `mediaUrl` or `mediaUrls`. URL suffixes are used to infer NAVER WORKS content type (`image`, `audio`, or `file`).
- Outbound text replies default to `markdownMode: "auto-flex"`, which detects markdown (headings/lists/links/tables/code blocks) and sends a NAVER WORKS Flexible Template (`content.type: "flex"`) for improved readability.
- Set `markdownMode: "plain"` if you always want raw text delivery (no markdown-to-flex conversion).
- `autoThinking` (optional) can auto-inject `/think <level>` before each inbound text based on keyword rules. Use this when you want NAVER WORKS requests to dynamically steer reasoning effort without manual `/think` commands.
- `autoThinking` precedence: explicit user `/think` wins (no auto-injection), then `highKeywords`, then `lowKeywords`, then `defaultLevel` fallback.
- `statusStickers` (optional) can send sticker-based status feedback for `received`, `processing`, and `failed` stages. Each stage uses `{ packageId, stickerId }`.
- If `statusStickers.enabled` is true but a stage sticker is omitted, OpenClaw uses defaults: `received`=`789/10855`, `processing`=`534/2429`, `failed`=`1/3`.
- Inbound audio attachments are downloaded to local media storage when reachable, so OpenClaw media-understanding/STT can transcribe voice messages for agents.
- Text-to-speech style audio replies are supported when the agent returns remote `mediaUrl`/`mediaUrls` audio links. Local file paths (for example raw `/tts audio` temp paths) are not uploadable by NAVER WORKS and are skipped with a warning.
- `strictBinding` defaults to `true`. When no binding matches, the plugin drops the event instead of falling back to the default agent.
- Set `strictBinding: false` if you want default-agent fallback behavior for unmatched DMs.
- `teamId` matching uses the event payload value from `source.teamId`, `source.domainId`, `source.tenantId`, `teamId`, `domainId`, or `tenantId` (first non-empty value wins).
- To discover the exact `teamId` value for bindings, check gateway logs for lines like `processing inbound event userId=... teamId=...` or `strictBinding dropped event ... teamId=...`, then copy that value into `bindings[].match.teamId`.
- Outbound send endpoint defaults to `https://www.worksapis.com/v1.0/bots/{botId}/users/{userId}/messages`. Override `apiBaseUrl` only if your environment needs a different base URL.
- Webhook auth: if `botSecret` is set, OpenClaw verifies `X-WORKS-Signature` using HMAC-SHA256 over the raw request body (per NAVER WORKS callback docs).
- Auth options for outbound: static `accessToken`, or JWT (`clientId` + `clientSecret` + `serviceAccount` + `privateKey`).
- If outbound auth is not configured, inbound still works but replies are skipped or auth-failed logs are emitted.
