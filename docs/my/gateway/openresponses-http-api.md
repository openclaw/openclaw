---
summary: "Gateway မှ OpenResponses နှင့် ကိုက်ညီသော /v1/responses HTTP endpoint ကို ဖော်ထုတ်ပေးခြင်း"
read_when:
  - OpenResponses API ကို ပြောဆိုနိုင်သော client များကို ပေါင်းစည်းရာတွင်
  - item-based inputs၊ client tool calls သို့မဟုတ် SSE events လိုအပ်သည့်အခါ
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaw ၏ Gateway သည် OpenResponses နှင့် ကိုက်ညီသော `POST /v1/responses` endpoint ကို ဆောင်ရွက်ပေးနိုင်သည်။

ဒီ endpoint ကို **ပုံမှန်အားဖြင့် ပိတ်ထားပါတယ်**။ config ထဲမှာ အရင်ဆုံး enable လုပ်ပါ။

- `POST /v1/responses`
- Gateway နှင့် တူညီသော port (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/responses`

အတွင်းပိုင်းတွင် request များကို ပုံမှန် Gateway agent run အဖြစ် အကောင်အထည်ဖော်ဆောင်ရွက်သည် (codepath သည်
`openclaw agent` နှင့် တူသည်) ထို့ကြောင့် routing/permissions/config များသည် သင်၏ Gateway နှင့် ကိုက်ညီပါသည်။

## Authentication

Gateway auth configuration ကို အသုံးပြုပါတယ်။ bearer token တစ်ခု ပို့ပါ။

- `Authorization: Bearer <token>`

မှတ်ချက်များ—

- `gateway.auth.mode="token"` ဖြစ်ပါက `gateway.auth.token` (သို့မဟုတ် `OPENCLAW_GATEWAY_TOKEN`) ကို အသုံးပြုပါ။
- `gateway.auth.mode="password"` ဖြစ်ပါက `gateway.auth.password` (သို့မဟုတ် `OPENCLAW_GATEWAY_PASSWORD`) ကို အသုံးပြုပါ။

## Agent ကို ရွေးချယ်ခြင်း

custom headers မလိုအပ်ပါ—OpenResponses ၏ `model` field တွင် agent id ကို encode လုပ်ပါ—

- `model: "openclaw:<agentId>"` (ဥပမာ—`"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

သို့မဟုတ် header ဖြင့် သီးသန့် OpenClaw agent တစ်ခုကို ဦးတည်နိုင်သည်—

- `x-openclaw-agent-id: <agentId>` (မူလတန်ဖိုး—`main`)

အဆင့်မြင့်—

- session routing ကို အပြည့်အဝ ထိန်းချုပ်ရန် `x-openclaw-session-key: <sessionKey>` ကို အသုံးပြုပါ။

## Endpoint ကို ဖွင့်ခြင်း

`gateway.http.endpoints.responses.enabled` ကို `true` သို့ သတ်မှတ်ပါ—

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

## Endpoint ကို ပိတ်ခြင်း

`gateway.http.endpoints.responses.enabled` ကို `false` သို့ သတ်မှတ်ပါ—

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

## Session အပြုအမူ

မူလအားဖြင့် endpoint သည် **request တစ်ခါစီအလိုက် stateless** ဖြစ်သည် (ခေါ်ဆိုမှုတိုင်းတွင် session key အသစ်တစ်ခု ထုတ်လုပ်သည်)။

Request တွင် OpenResponses ၏ `user` string ပါဝင်ပါက Gateway သည် ထိုအချက်အလက်မှ stable session key တစ်ခုကို ဆင်းသက်ထုတ်ယူပြီး ထပ်ခါတလဲလဲ ခေါ်ဆိုမှုများအတွက် agent session တစ်ခုကို မျှဝေအသုံးပြုနိုင်စေသည်။

## Request ပုံစံ (ထောက်ပံ့ထားသည်)

ဒီ request က item-based input ပါတဲ့ OpenResponses API ကို လိုက်နာပါတယ်။ လက်ရှိ support လုပ်ထားတာများ:

- `input`: string သို့မဟုတ် item object များ၏ array။
- `instructions`: system prompt ထဲသို့ ပေါင်းထည့်သည်။
- `tools`: client tool definitions (function tools)။
- `tool_choice`: client tools များကို filter လုပ်ခြင်း သို့မဟုတ် မဖြစ်မနေ လိုအပ်စေခြင်း။
- `stream`: SSE streaming ကို ဖွင့်ပေးသည်။
- `max_output_tokens`: best-effort output limit (provider အပေါ်မူတည်)။
- `user`: stable session routing။

လက်ခံသော်လည်း **လက်ရှိတွင် လျစ်လျူရှုထားသည်**—

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (input)

### `message`

Roles: `system`, `developer`, `user`, `assistant`။

- `system` နှင့် `developer` ကို system prompt ထဲသို့ ပေါင်းထည့်သည်။
- နောက်ဆုံးရှိသော `user` သို့မဟုတ် `function_call_output` item သည် “current message” ဖြစ်လာသည်။
- အစောပိုင်း user/assistant message များကို context အတွက် history အဖြစ် ထည့်သွင်းထားသည်။

### `function_call_output` (turn-based tools)

Tool ရလဒ်များကို မော်ဒယ်သို့ ပြန်ပို့ပါ—

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` နှင့် `item_reference`

Schema ကိုက်ညီမှုအတွက် လက်ခံသော်လည်း prompt တည်ဆောက်ရာတွင် လျစ်လျူရှုထားသည်။

## Tools (client-side function tools)

`tools: [{ type: "function", function: { name, description?, parameters?` နဲ့ tools ပေးပါ။ `} }]`။

agent က tool ကို ခေါ်ရန် ဆုံးဖြတ်ရင် response ထဲမှာ `function_call` output item ကို ပြန်ပေးပါတယ်။
ပြီးရင် turn ကို ဆက်လက်လုပ်ဆောင်ဖို့ `function_call_output` နဲ့ follow-up request တစ်ခု ပို့ရပါမယ်။

## Images (`input_image`)

base64 သို့မဟုတ် URL source များကို ထောက်ပံ့သည်—

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

ခွင့်ပြုထားတဲ့ MIME types (လက်ရှိ): `image/jpeg`, `image/png`, `image/gif`, `image/webp`။
အများဆုံး အရွယ်အစား (လက်ရှိ): 10MB။

## Files (`input_file`)

base64 သို့မဟုတ် URL source များကို ထောက်ပံ့သည်—

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

ခွင့်ပြုထားသော MIME types (လက်ရှိ)—`text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`။

အများဆုံး အရွယ်အစား (လက်ရှိ)—5MB။

လက်ရှိ အပြုအမူ—

- File အကြောင်းအရာကို decode လုပ်ပြီး **system prompt** ထဲသို့ ထည့်သွင်းသည် (user message မဟုတ်ပါ)၊
  ထို့ကြောင့် ephemeral ဖြစ်ပြီး session history တွင် မသိမ်းဆည်းပါ။
- PDF ဖိုင်တွေကို စာသားအတွက် parse လုပ်ပါတယ်။ စာသား နည်းနည်းပဲ တွေ့ရရင် ပထမစာမျက်နှာတွေကို rasterize လုပ်ပြီး

image အဖြစ် ပြောင်းလဲကာ model ဆီကို ပို့ပါတယ်။ PDF parsing က Node-friendly `pdfjs-dist` legacy build (worker မပါ) ကို အသုံးပြုပါတယ်။

URL fetch မူလတန်ဖိုးများ—

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Request များကို ကာကွယ်ထားသည် (DNS resolution, private IP blocking, redirect caps, timeouts)။

## File + image ကန့်သတ်ချက်များ (config)

မူလတန်ဖိုးများကို `gateway.http.endpoints.responses` အောက်တွင် ချိန်ညှိနိုင်သည်—

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

မထည့်သွင်းထားပါက အသုံးပြုမည့် မူလတန်ဖိုးများ—

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

Server-Sent Events (SSE) ကို လက်ခံရန် `stream: true` ကို သတ်မှတ်ပါ—

- `Content-Type: text/event-stream`
- Event line တစ်ကြောင်းချင်းစီသည် `event: <type>` နှင့် `data: <json>` ဖြစ်သည်
- Stream သည် `data: [DONE]` ဖြင့် အဆုံးသတ်သည်

လက်ရှိ ထုတ်လွှတ်နေသော event အမျိုးအစားများ—

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (အမှား ဖြစ်ပေါ်သည့်အခါ)

## Usage

အောက်ခံ provider က token အရေအတွက်များကို အစီရင်ခံပေးသောအခါ `usage` ကို ဖြည့်သွင်းပေးသည်။

## Errors

Error များသည် အောက်ပါအတိုင်း JSON object တစ်ခုကို အသုံးပြုသည်—

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

အများဆုံးတွေ့ရသော အခြေအနေများ—

- `401` authentication မရှိခြင်း/မမှန်ကန်ခြင်း
- `400` request body မမှန်ကန်ခြင်း
- `405` method မှားယွင်းခြင်း

## Examples

Streaming မပါဘဲ—

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

Streaming—

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
