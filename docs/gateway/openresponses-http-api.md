---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Expose an OpenResponses-compatible /v1/responses HTTP endpoint from the Gateway"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Integrating clients that speak the OpenResponses API（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want item-based inputs, client tool calls, or SSE events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "OpenResponses API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenResponses API (HTTP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw’s Gateway can serve an OpenResponses-compatible `POST /v1/responses` endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This endpoint is **disabled by default**. Enable it in config first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /v1/responses`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/responses`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Under the hood, requests are executed as a normal Gateway agent run (same codepath as（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw agent`), so routing/permissions/config match your Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Authentication（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Uses the Gateway auth configuration. Send a bearer token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Authorization: Bearer <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Choosing an agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No custom headers required: encode the agent id in the OpenResponses `model` field:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model: "openclaw:<agentId>"` (example: `"openclaw:main"`, `"openclaw:beta"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model: "agent:<agentId>"` (alias)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or target a specific OpenClaw agent by header:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `x-openclaw-agent-id: <agentId>` (default: `main`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Advanced:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `x-openclaw-session-key: <sessionKey>` to fully control session routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enabling the endpoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `gateway.http.endpoints.responses.enabled` to `true`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    http: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      endpoints: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        responses: { enabled: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Disabling the endpoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `gateway.http.endpoints.responses.enabled` to `false`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    http: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      endpoints: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        responses: { enabled: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default the endpoint is **stateless per request** (a new session key is generated each call).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the request includes an OpenResponses `user` string, the Gateway derives a stable session key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
from it, so repeated calls can share an agent session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Request shape (supported)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The request follows the OpenResponses API with item-based input. Current support:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `input`: string or array of item objects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `instructions`: merged into the system prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools`: client tool definitions (function tools).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tool_choice`: filter or require client tools.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stream`: enables SSE streaming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `max_output_tokens`: best-effort output limit (provider dependent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `user`: stable session routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Accepted but **currently ignored**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `max_tool_calls`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reasoning`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `metadata`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `store`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `previous_response_id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `truncation`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Items (input)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Roles: `system`, `developer`, `user`, `assistant`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system` and `developer` are appended to the system prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The most recent `user` or `function_call_output` item becomes the “current message.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Earlier user/assistant messages are included as history for context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `function_call_output` (turn-based tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send tool results back to the model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "function_call_output",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "call_id": "call_123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "output": "{\"temperature\": \"72F\"}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `reasoning` and `item_reference`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Accepted for schema compatibility but ignored when building the prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tools (client-side function tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provide tools with `tools: [{ type: "function", function: { name, description?, parameters? } }]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the agent decides to call a tool, the response returns a `function_call` output item.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You then send a follow-up request with `function_call_output` to continue the turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Images (`input_image`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supports base64 or URL sources:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "input_image",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "source": { "type": "url", "url": "https://example.com/image.png" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowed MIME types (current): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Max size (current): 10MB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Files (`input_file`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supports base64 or URL sources:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "type": "input_file",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "source": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "base64",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "media_type": "text/plain",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "data": "SGVsbG8gV29ybGQh",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "filename": "hello.txt"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowed MIME types (current): `text/plain`, `text/markdown`, `text/html`, `text/csv`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`application/json`, `application/pdf`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Max size (current): 5MB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- File content is decoded and added to the **system prompt**, not the user message,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  so it stays ephemeral (not persisted in session history).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- PDFs are parsed for text. If little text is found, the first pages are rasterized（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  into images and passed to the model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PDF parsing uses the Node-friendly `pdfjs-dist` legacy build (no worker). The modern（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PDF.js build expects browser workers/DOM globals, so it is not used in the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
URL fetch defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files.allowUrl`: `true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `images.allowUrl`: `true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requests are guarded (DNS resolution, private IP blocking, redirect caps, timeouts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## File + image limits (config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults can be tuned under `gateway.http.endpoints.responses`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    http: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      endpoints: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        responses: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          maxBodyBytes: 20000000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          files: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            allowUrl: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            allowedMimes: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "text/plain",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "text/markdown",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "text/html",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "text/csv",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "application/json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "application/pdf",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxBytes: 5242880,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxChars: 200000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxRedirects: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            timeoutMs: 10000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            pdf: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              maxPages: 4,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              maxPixels: 4000000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              minTextChars: 200,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          images: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            allowUrl: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxBytes: 10485760,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxRedirects: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            timeoutMs: 10000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults when omitted:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxBodyBytes`: 20MB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files.maxBytes`: 5MB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files.maxChars`: 200k（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files.maxRedirects`: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files.timeoutMs`: 10s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files.pdf.maxPages`: 4（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files.pdf.maxPixels`: 4,000,000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `files.pdf.minTextChars`: 200（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `images.maxBytes`: 10MB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `images.maxRedirects`: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `images.timeoutMs`: 10s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Streaming (SSE)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `stream: true` to receive Server-Sent Events (SSE):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Content-Type: text/event-stream`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each event line is `event: <type>` and `data: <json>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stream ends with `data: [DONE]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Event types currently emitted:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.created`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.in_progress`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.output_item.added`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.content_part.added`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.output_text.delta`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.output_text.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.content_part.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.output_item.done`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.completed`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `response.failed` (on error)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`usage` is populated when the underlying provider reports token counts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Errors use a JSON object like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "error": { "message": "...", "type": "invalid_request_error" } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common cases:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `401` missing/invalid auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `400` invalid request body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `405` wrong method（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Non-streaming:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -sS http://127.0.0.1:18789/v1/responses \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Authorization: Bearer YOUR_TOKEN' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'x-openclaw-agent-id: main' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "model": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "input": "hi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Streaming:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -N http://127.0.0.1:18789/v1/responses \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Authorization: Bearer YOUR_TOKEN' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'x-openclaw-agent-id: main' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "model": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "stream": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "input": "hi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
