---
summary: "I-expose ang OpenResponses-compatible na /v1/responses HTTP endpoint mula sa Gateway"
read_when:
  - Pag-integrate ng mga client na nagsasalita ng OpenResponses API
  - Gusto mo ng item-based inputs, client tool calls, o SSE events
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

Maaaring mag-serve ang Gateway ng OpenClaw ng isang OpenResponses-compatible `POST /v1/responses` endpoint.

This endpoint is **disabled by default**. Enable it in config first.

- `POST /v1/responses`
- Parehong port ng Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/responses`

Sa ilalim ng hood, ang mga request ay isinasagawa bilang isang normal na Gateway agent run (parehong codepath gaya ng
`openclaw agent`), kaya tumutugma ang routing/permissions/config sa iyong Gateway.

## Authentication

Uses the Gateway auth configuration. Magpadala ng bearer token:

- `Authorization: Bearer <token>`

Mga tala:

- Kapag `gateway.auth.mode="token"`, gamitin ang `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Kapag `gateway.auth.mode="password"`, gamitin ang `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).

## Pagpili ng agent

Walang custom headers na kailangan: i-encode ang agent id sa OpenResponses `model` field:

- `model: "openclaw:<agentId>"` (halimbawa: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

O i-target ang isang partikular na OpenClaw agent sa pamamagitan ng header:

- `x-openclaw-agent-id: <agentId>` (default: `main`)

Advanced:

- `x-openclaw-session-key: <sessionKey>` para ganap na kontrolin ang session routing.

## Pag-enable ng endpoint

Itakda ang `gateway.http.endpoints.responses.enabled` sa `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## Pag-disable ng endpoint

Itakda ang `gateway.http.endpoints.responses.enabled` sa `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## Pag-uugali ng session

Bilang default, ang endpoint ay **stateless bawat request** (isang bagong session key ang nalilikha sa bawat tawag).

Kung ang request ay may kasamang OpenResponses `user` string, kumukuha ang Gateway ng isang stable na session key
mula rito, kaya maaaring magbahagi ng agent session ang mga paulit-ulit na tawag.

## Hugis ng request (sinusuportahan)

The request follows the OpenResponses API with item-based input. Current support:

- `input`: string o array ng mga item object.
- `instructions`: pinagsasama sa system prompt.
- `tools`: mga client tool definition (function tools).
- `tool_choice`: i-filter o i-require ang mga client tool.
- `stream`: nag-e-enable ng SSE streaming.
- `max_output_tokens`: best-effort na limitasyon sa output (provider dependent).
- `user`: stable na session routing.

Tinanggap ngunit **kasalukuyang ini-ignore**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Mga Item (input)

### `message`

Mga role: `system`, `developer`, `user`, `assistant`.

- Ang `system` at `developer` ay idinadagdag sa system prompt.
- Ang pinakahuling `user` o `function_call_output` na item ang nagiging “current message.”
- Ang mga naunang user/assistant na mensahe ay isinasama bilang history para sa context.

### `function_call_output` (turn-based tools)

Ipadala pabalik sa model ang mga resulta ng tool:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` at `item_reference`

Tinanggap para sa schema compatibility ngunit ini-ignore kapag binubuo ang prompt.

## Mga Tool (client-side function tools)

Provide tools with `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

If the agent decides to call a tool, the response returns a `function_call` output item.
You then send a follow-up request with `function_call_output` to continue the turn.

## Mga Larawan (`input_image`)

Sinusuportahan ang base64 o URL sources:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Allowed MIME types (current): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Max size (current): 10MB.

## Mga File (`input_file`)

Sinusuportahan ang base64 o URL sources:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

Mga pinapayagang MIME type (kasalukuyan): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Max na laki (kasalukuyan): 5MB.

Kasalukuyang pag-uugali:

- Ang nilalaman ng file ay dini-decode at idinadagdag sa **system prompt**, hindi sa user message,
  kaya nananatili itong ephemeral (hindi ipinapersist sa session history).
- PDFs are parsed for text. If little text is found, the first pages are rasterized
  into images and passed to the model.

PDF parsing uses the Node-friendly `pdfjs-dist` legacy build (no worker). The modern
PDF.js build expects browser workers/DOM globals, so it is not used in the Gateway.

Mga default sa pag-fetch ng URL:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Ang mga request ay may bantay (DNS resolution, pag-block ng private IP, mga limitasyon sa redirect, mga timeout).

## Mga limitasyon ng file + image (config)

Maaaring i-tune ang mga default sa ilalim ng `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Mga default kapag wala:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## Streaming (SSE)

Itakda ang `stream: true` upang makatanggap ng Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Ang bawat event line ay `event: <type>` at `data: <json>`
- Nagtatapos ang stream sa `data: [DONE]`

Mga uri ng event na kasalukuyang inilalabas:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (kapag may error)

## Paggamit

Ang `usage` ay napupunan kapag ang underlying provider ay nag-uulat ng mga bilang ng token.

## Mga Error

Gumagamit ang mga error ng isang JSON object na tulad ng:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Mga karaniwang kaso:

- `401` kulang/invalid na auth
- `400` invalid na request body
- `405` maling method

## Mga Halimbawa

Hindi streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
