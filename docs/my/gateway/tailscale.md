---
summary: "Gateway ဒက်ရှ်ဘုတ်အတွက် Tailscale Serve/Funnel ကို ပေါင်းစည်းအသုံးပြုနိုင်ရန်"
read_when:
  - Gateway Control UI ကို localhost ပြင်ပသို့ ဖော်ထုတ်အသုံးပြုရန်
  - tailnet သို့မဟုတ် အများပြည်သူဆိုင်ရာ ဒက်ရှ်ဘုတ် ဝင်ရောက်မှုကို အလိုအလျောက်လုပ်ဆောင်ရန်
title: "Tailscale"
---

# Tailscale (Gateway ဒက်ရှ်ဘုတ်)

OpenClaw သည် Gateway dashboard နှင့် WebSocket port အတွက် Tailscale **Serve** (tailnet) သို့မဟုတ် **Funnel** (public) ကို အလိုအလျောက် ပြင်ဆင်နိုင်ပါသည်။ ဤအရာသည် Gateway ကို loopback တွင် ချိတ်ထားပြီး Tailscale က HTTPS, routing နှင့် (Serve အတွက်) identity headers များကို ပံ့ပိုးပေးပါသည်။

## Modes

- `serve`: `tailscale serve` ကို အသုံးပြုထားသော Tailnet-သာ Serve ဖြစ်သည်။ Gateway သည် `127.0.0.1` ပေါ်တွင် ဆက်လက်ရှိနေပါသည်။
- `funnel`: `tailscale funnel` မှတစ်ဆင့် Public HTTPS ဖြစ်သည်။ OpenClaw သည် မျှဝေထားသော စကားဝှက်တစ်ခုကို လိုအပ်ပါသည်။
- `off`: မူလအခြေအနေ (Tailscale အလိုအလျောက် ပြင်ဆင်ခြင်း မရှိ)။

## Auth

လက်ဆောင်ချိတ်ဆက်မှုကို ထိန်းချုပ်ရန် `gateway.auth.mode` ကို သတ်မှတ်ပါ–

- `token` (`OPENCLAW_GATEWAY_TOKEN` ကို သတ်မှတ်ထားသည့်အခါ မူလအဖြစ်)
- `password` (`OPENCLAW_GATEWAY_PASSWORD` သို့မဟုတ် config မှတဆင့် မျှဝေထားသော လျှို့ဝှက်ချက်)

`tailscale.mode = "serve"` ဖြစ်ပြီး `gateway.auth.allowTailscale` ကို `true` သတ်မှတ်ထားသောအခါ၊ မှန်ကန်သော Serve proxy request များသည် token/စကားဝှက် မပေးဘဲ Tailscale identity headers (`tailscale-user-login`) ဖြင့် အတည်ပြုနိုင်ပါသည်။ OpenClaw သည် local Tailscale daemon (`tailscale whois`) မှတစ်ဆင့် `x-forwarded-for` လိပ်စာကို ဖြေရှင်းကာ header နှင့် ကိုက်ညီမှုရှိမရှိ စစ်ဆေးပြီး လက်ခံပါသည်။
OpenClaw သည် loopback မှလာပြီး Tailscale ၏ `x-forwarded-for`, `x-forwarded-proto`, နှင့် `x-forwarded-host` headers ပါရှိသော request များကိုသာ Serve အဖြစ် သတ်မှတ်ပါသည်။
အတည်ပြုအချက်အလက်များကို တိတိကျကျ လိုအပ်စေရန် `gateway.auth.allowTailscale: false` သတ်မှတ်ပါ သို့မဟုတ် `gateway.auth.mode: "password"` ကို အတင်းအကျပ် သတ်မှတ်ပါ။

## Config examples

### Tailnet-only (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

ဖွင့်ရန်: `https://<magicdns>/` (သို့မဟုတ် သင် ပြင်ဆင်ထားသော `gateway.controlUi.basePath`)

### Tailnet-only (Tailnet IP သို့ bind)

Gateway ကို Tailnet IP ပေါ်တွင် တိုက်ရိုက် နားထောင်စေလိုသည့်အခါ (Serve/Funnel မပါ) အသုံးပြုပါ။

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

အခြား Tailnet စက်မှ ချိတ်ဆက်ရန်–

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

မှတ်ချက်: loopback (`http://127.0.0.1:18789`) သည် ဤမုဒ်တွင် **အလုပ်မလုပ်ပါ**။

### အများပြည်သူအင်တာနက် (Funnel + မျှဝေထားသော စကားဝှက်)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

စကားဝှက်ကို disk ပေါ်တွင် သိမ်းဆည်းခြင်းထက် `OPENCLAW_GATEWAY_PASSWORD` ကို ဦးစားပေး အသုံးပြုပါ။

## CLI examples

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notes

- Tailscale Serve/Funnel ကို အသုံးပြုရန် `tailscale` CLI ကို ထည့်သွင်းပြီး လော့ဂ်အင်ဝင်ထားရပါမည်။
- `tailscale.mode: "funnel"` သည် အများပြည်သူသို့ ဖော်ထုတ်ခြင်းကို ရှောင်ရှားရန်
  auth mode ကို `password` မဟုတ်ပါက စတင်ရန် ငြင်းပယ်ပါသည်။
- Shutdown အချိန်တွင် OpenClaw က `tailscale serve`
  သို့မဟုတ် `tailscale funnel` ပြင်ဆင်ချက်များကို ပြန်လည်ဖျက်သိမ်းစေလိုပါက `gateway.tailscale.resetOnExit` ကို သတ်မှတ်ပါ။
- `gateway.bind: "tailnet"` သည် Tailnet သို့ တိုက်ရိုက် bind (HTTPS မပါ၊ Serve/Funnel မပါ) ဖြစ်သည်။
- `gateway.bind: "auto"` သည် loopback ကို ဦးစားပေးသည်; Tailnet-only လိုအပ်ပါက `tailnet` ကို အသုံးပြုပါ။
- Serve/Funnel သည် **Gateway control UI + WS** ကိုသာ ဖော်ပြပေးပါသည်။ Node များသည် တူညီသော Gateway WS endpoint မှတစ်ဆင့် ချိတ်ဆက်သောကြောင့် Serve သည် node access အတွက်လည်း အလုပ်လုပ်နိုင်ပါသည်။

## Browser control (remote Gateway + local browser)

Gateway ကို စက်တစ်လုံးပေါ်တွင် chạy လုပ်ထားပြီး အခြားစက်တစ်လုံးပေါ်ရှိ browser ကို ထိန်းချုပ်လိုပါက၊ browser စက်ပေါ်တွင် **node host** တစ်ခု chạy လုပ်ပြီး နှစ်ဖက်လုံးကို တူညီသော tailnet ပေါ်တွင် ထားပါ။
Gateway သည် browser လုပ်ဆောင်ချက်များကို node သို့ proxy လုပ်ပေးမည်ဖြစ်ပြီး၊ သီးခြား control server သို့မဟုတ် Serve URL မလိုအပ်ပါ။

Browser control အတွက် Funnel ကို မသုံးပါနှင့်; node pairing ကို operator ဝင်ရောက်မှုကဲ့သို့ ဆက်ဆံပါ။

## Tailscale prerequisites + limits

- Serve အတွက် သင့် tailnet တွင် HTTPS ကို ဖွင့်ထားရပါမည်; မရှိပါက CLI က အချက်ပြမေးမြန်းပါသည်။
- Serve သည် Tailscale identity headers များကို ထည့်သွင်းပေးသည်; Funnel မထည့်သွင်းပါ။
- Funnel အတွက် Tailscale v1.38.3+၊ MagicDNS၊ HTTPS ဖွင့်ထားခြင်း၊ နှင့် funnel node attribute လိုအပ်ပါသည်။
- Funnel သည် TLS ဖြင့် ပို့တ် `443`, `8443`, နှင့် `10000` ကိုသာ ထောက်ပံ့ပါသည်။
- macOS ပေါ်ရှိ Funnel သည် open-source Tailscale app မျိုးကွဲကို လိုအပ်ပါသည်။

## Learn more

- Tailscale Serve overview: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` command: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel overview: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` command: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
