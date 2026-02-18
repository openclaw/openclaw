---
summary: "Gateway ဝဘ် မျက်နှာပြင်များ — Control UI၊ bind modes နှင့် လုံခြုံရေး"
read_when:
  - သင် Tailscale မှတဆင့် Gateway ကို ဝင်ရောက်လိုပါက
  - ဘရောက်ဇာ Control UI နှင့် config တည်းဖြတ်ခြင်းကို လိုအပ်ပါက
title: "ဝဘ်"
---

# ဝဘ် (Gateway)

Gateway သည် Gateway WebSocket နှင့် တူညီသော ပို့တ်မှ **ဘရောက်ဇာ Control UI** (Vite + Lit) အသေးစားကို ဆောင်ရွက်ပေးပါသည်—

- မူလတန်ဖိုး: `http://<host>:18789/`
- ရွေးချယ်နိုင်သော prefix: `gateway.controlUi.basePath` ကို သတ်မှတ်ပါ (ဥပမာ `/openclaw`)

22. Capabilities များကို [Control UI](/web/control-ui) တွင် ရှိပါသည်။
23. ဤစာမျက်နှာသည် bind modes၊ လုံခြုံရေး နှင့် web-facing surfaces များကို အဓိကထား ဖော်ပြပါသည်။

## Webhooks

24. `hooks.enabled=true` ဖြစ်ပါက Gateway သည် တူညီသော HTTP server ပေါ်တွင် webhook endpoint အသေးတစ်ခုကိုပါ ဖော်ပြပါသည်။
25. auth + payloads အတွက် [Gateway configuration](/gateway/configuration) → `hooks` ကို ကြည့်ပါ။

## Config (မူလအားဖြင့် ဖွင့်ထားသည်)

26. assets (`dist/control-ui`) ရှိပါက Control UI ကို **default အနေဖြင့် enable လုပ်ထားပါသည်**။
27. config ဖြင့် ထိန်းချုပ်နိုင်ပါသည်:

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
- 28. Serve အသုံးပြုသောအခါ `gateway.auth.allowTailscale` သည် `true` ဖြစ်ပါက Tailscale identity headers များဖြင့် auth ကို ဖြည့်ဆည်းနိုင်ပါသည် (token/password မလိုအပ်ပါ)။ 29. ထင်ရှားသော credentials လိုအပ်စေရန် `gateway.auth.allowTailscale: false` ကို set လုပ်ပါ။ 30. [Tailscale](/gateway/tailscale) နှင့် [Security](/gateway/security) ကို ကြည့်ပါ။
- `gateway.tailscale.mode: "funnel"` သည် `gateway.auth.mode: "password"` (မျှဝေထားသော password) ကို လိုအပ်ပါသည်။

## UI ကို တည်ဆောက်ခြင်း

31. Gateway သည် static files များကို `dist/control-ui` မှ serve လုပ်ပါသည်။ 32. အောက်ပါအတိုင်း build လုပ်ပါ:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
