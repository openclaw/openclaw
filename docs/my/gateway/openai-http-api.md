---
summary: "Gateway မှ OpenAI နှင့် ကိုက်ညီသော /v1/chat/completions HTTP endpoint ကို ထုတ်ဖော်ပေးသည်"
read_when:
  - OpenAI Chat Completions ကို မျှော်မှန်းထားသော ကိရိယာများနှင့် ပေါင်းစည်းသည့်အခါ
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw ၏ Gateway သည် OpenAI နှင့် ကိုက်ညီသော Chat Completions endpoint အသေးစားတစ်ခုကို ဝန်ဆောင်မှုပေးနိုင်သည်။

ဤ endpoint ကို **မူလအနေဖြင့် ပိတ်ထားသည်**။ config ထဲမှာ အရင်ဆုံး enable လုပ်ပါ။

- `POST /v1/chat/completions`
- Gateway နှင့် တူညီသော port (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

အောက်ခံအလုပ်လုပ်ပုံအရ၊ တောင်းဆိုမှုများကို ပုံမှန် Gateway agent run အဖြစ် အကောင်အထည်ဖော်သည် (`openclaw agent` နှင့် တူညီသော codepath)၊ ထို့ကြောင့် routing/permissions/config များသည် သင့် Gateway နှင့် ကိုက်ညီပါသည်။

## Authentication

Gateway auth configuration ကို အသုံးပြုပါတယ်။ bearer token တစ်ခု ပို့ပါ။

- `Authorization: Bearer <token>`

မှတ်ချက်များ—

- `gateway.auth.mode="token"` ဖြစ်သောအခါ `gateway.auth.token` (သို့မဟုတ် `OPENCLAW_GATEWAY_TOKEN`) ကို အသုံးပြုပါ။
- `gateway.auth.mode="password"` ဖြစ်သောအခါ `gateway.auth.password` (သို့မဟုတ် `OPENCLAW_GATEWAY_PASSWORD`) ကို အသုံးပြုပါ။

## Agent ကို ရွေးချယ်ခြင်း

custom headers မလိုအပ်ပါ—OpenAI ၏ `model` field ထဲတွင် agent id ကို encode လုပ်ပါ—

- `model: "openclaw:<agentId>"` (ဥပမာ— `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

သို့မဟုတ် header ဖြင့် သတ်မှတ်ထားသော OpenClaw agent တစ်ခုကို ဦးတည်နိုင်ပါသည်—

- `x-openclaw-agent-id: <agentId>` (default— `main`)

အဆင့်မြင့်—

- session routing ကို အပြည့်အဝ ထိန်းချုပ်ရန် `x-openclaw-session-key: <sessionKey>` ကို အသုံးပြုပါ။

## Endpoint ကို ဖွင့်ခြင်း

`gateway.http.endpoints.chatCompletions.enabled` ကို `true` အဖြစ် သတ်မှတ်ပါ—

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Endpoint ကို ပိတ်ခြင်း

`gateway.http.endpoints.chatCompletions.enabled` ကို `false` အဖြစ် သတ်မှတ်ပါ—

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Session အပြုအမူ

ပုံမှန်အားဖြင့် endpoint သည် **တောင်းဆိုမှုတစ်ခုချင်းစီအလိုက် stateless** ဖြစ်ပြီး (call တစ်ခါချင်းစီတွင် session key အသစ်တစ်ခု ထုတ်လုပ်သည်)။

တောင်းဆိုမှုတွင် OpenAI ၏ `user` string ပါဝင်ပါက Gateway သည် ၎င်းမှ အတည်ငြိမ်သော session key ကို ဆင်းသက်ထုတ်ယူပြီး ထပ်ခါတလဲလဲ ခေါ်ဆိုမှုများအတွက် agent session ကို မျှဝေအသုံးပြုနိုင်စေသည်။

## Streaming (SSE)

Server-Sent Events (SSE) ကို ရယူရန် `stream: true` ကို သတ်မှတ်ပါ—

- `Content-Type: text/event-stream`
- event line တစ်ကြောင်းစီသည် `data: <json>` ဖြစ်သည်
- stream သည် `data: [DONE]` ဖြင့် အဆုံးသတ်သည်

## ဥပမာများ

Non-streaming—

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming—

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
