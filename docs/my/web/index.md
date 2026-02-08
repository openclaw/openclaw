---
summary: "Gateway ဝဘ် မျက်နှာပြင်များ — Control UI၊ bind modes နှင့် လုံခြုံရေး"
read_when:
  - သင် Tailscale မှတဆင့် Gateway ကို ဝင်ရောက်လိုပါက
  - ဘရောက်ဇာ Control UI နှင့် config တည်းဖြတ်ခြင်းကို လိုအပ်ပါက
title: "ဝဘ်"
x-i18n:
  source_path: web/index.md
  source_hash: 1315450b71a799c8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:06Z
---

# ဝဘ် (Gateway)

Gateway သည် Gateway WebSocket နှင့် တူညီသော ပို့တ်မှ **ဘရောက်ဇာ Control UI** (Vite + Lit) အသေးစားကို ဆောင်ရွက်ပေးပါသည်—

- မူလတန်ဖိုး: `http://<host>:18789/`
- ရွေးချယ်နိုင်သော prefix: `gateway.controlUi.basePath` ကို သတ်မှတ်ပါ (ဥပမာ `/openclaw`)

စွမ်းရည်များကို [Control UI](/web/control-ui) တွင် တွေ့နိုင်ပါသည်။
ဤစာမျက်နှာသည် bind modes၊ လုံခြုံရေးနှင့် ဝဘ်ဘက်သို့ ထိတွေ့နေသော မျက်နှာပြင်များကို အဓိကထား ရှင်းပြပါသည်။

## Webhooks

`hooks.enabled=true` ဖြစ်ပါက Gateway သည် တူညီသော HTTP ဆာဗာပေါ်တွင် webhook endpoint အသေးစားတစ်ခုကိုလည်း ဖော်ပြပေးပါသည်။
auth နှင့် payloads အတွက် [Gateway configuration](/gateway/configuration) → `hooks` ကို ကြည့်ပါ။

## Config (မူလအားဖြင့် ဖွင့်ထားသည်)

assets များ ရှိနေပါက Control UI ကို **မူလအားဖြင့် ဖွင့်ထားပါသည်** (`dist/control-ui`)။
config ဖြင့် ထိန်းချုပ်နိုင်ပါသည်—

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale ဖြင့် ဝင်ရောက်ခြင်း

### Integrated Serve (အကြံပြုထားသည်)

Gateway ကို loopback ပေါ်တွင် ထားပြီး Tailscale Serve ဖြင့် proxy လုပ်ပါ—

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

ထို့နောက် gateway ကို စတင်ပါ—

```bash
openclaw gateway
```

ဖွင့်ရန်—

- `https://<magicdns>/` (သို့မဟုတ် သင် သတ်မှတ်ထားသော `gateway.controlUi.basePath`)

### Tailnet bind + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

ထို့နောက် gateway ကို စတင်ပါ (loopback မဟုတ်သော bind များအတွက် token လိုအပ်ပါသည်)—

```bash
openclaw gateway
```

ဖွင့်ရန်—

- `http://<tailscale-ip>:18789/` (သို့မဟုတ် သင် သတ်မှတ်ထားသော `gateway.controlUi.basePath`)

### အများပြည်သူ အင်တာနက် (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## လုံခြုံရေး မှတ်ချက်များ

- Gateway auth ကို မူလအားဖြင့် လိုအပ်ပါသည် (token/password သို့မဟုတ် Tailscale identity headers)။
- Loopback မဟုတ်သော bind များတွင် **မဖြစ်မနေ** မျှဝေထားသော token/password (`gateway.auth` သို့မဟုတ် env) ကို လိုအပ်ပါသည်။
- wizard သည် loopback ပေါ်တွင်တောင် မူလအားဖြင့် gateway token တစ်ခုကို ဖန်တီးပေးပါသည်။
- UI သည် `connect.params.auth.token` သို့မဟုတ် `connect.params.auth.password` ကို ပို့ပေးပါသည်။
- Control UI သည် anti-clickjacking headers များကို ပို့ပြီး `gateway.controlUi.allowedOrigins` ကို မသတ်မှတ်ထားပါက same-origin ဘရောက်ဇာ websocket ချိတ်ဆက်မှုများကိုသာ လက်ခံပါသည်။
- Serve ကို အသုံးပြုပါက Tailscale identity headers များသည်
  `gateway.auth.allowTailscale` ကို `true` ဖြစ်စေထားသောအခါ auth ကို ဖြည့်ဆည်းပေးနိုင်ပါသည် (token/password မလိုအပ်ပါ)။ သတ်မှတ်ရန်
  `gateway.auth.allowTailscale: false` ကို သုံးပြီး အတိအကျ အထောက်အထားများကို လိုအပ်စေပါ။ ကြည့်ရန်
  [Tailscale](/gateway/tailscale) နှင့် [Security](/gateway/security)။
- `gateway.tailscale.mode: "funnel"` သည် `gateway.auth.mode: "password"` (မျှဝေထားသော password) ကို လိုအပ်ပါသည်။

## UI ကို တည်ဆောက်ခြင်း

Gateway သည် `dist/control-ui` မှ static ဖိုင်များကို ဆောင်ရွက်ပေးပါသည်။ အောက်ပါအတိုင်း တည်ဆောက်ပါ—

```bash
pnpm ui:build # auto-installs UI deps on first run
```
