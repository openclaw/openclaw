---
summary: "SSH တန်နယ်များ (Gateway WS) နှင့် tailnet များကို အသုံးပြု၍ အဝေးမှ ဝင်ရောက်အသုံးပြုခြင်း"
read_when:
  - အဝေးမှ Gateway တပ်ဆင်မှုများကို လည်ပတ်စဉ် သို့မဟုတ် ပြဿနာရှာဖွေစစ်ဆေးစဉ်
title: "အဝေးမှ ဝင်ရောက်အသုံးပြုခြင်း"
---

# အဝေးမှ ဝင်ရောက်အသုံးပြုခြင်း (SSH၊ တန်နယ်များ၊ နှင့် tailnet များ)

ဤ repo သည် “SSH ဖြင့် အဝေးမှချိတ်ဆက်ခြင်း” ကို ပံ့ပိုးပေးပြီး သီးသန့် ဟို့စ် (desktop/server) ပေါ်တွင် Gateway (မေတ္တာဆရာ) တစ်ခုတည်းကို လည်ပတ်ထားကာ client များကို ၎င်းနှင့် ချိတ်ဆက်စေပါသည်။

- **အော်ပရေးတာများ (သင် / macOS အက်ပ်)** အတွက် — SSH တန်နယ်သည် အထွေထွေ အစားထိုးဖြစ်သည်။
- **နိုဒ်များ (iOS/Android နှင့် အနာဂတ် စက်များ)** အတွက် — လိုအပ်သလို LAN/tailnet သို့မဟုတ် SSH တန်နယ်ဖြင့် Gateway **WebSocket** သို့ ချိတ်ဆက်ပါ။

## အဓိက အယူအဆ

- Gateway WebSocket သည် သင် သတ်မှတ်ထားသော ပို့တ်တွင် **loopback** သို့ bind လုပ်ထားသည် (မူလတန်ဖိုး 18789)။
- အဝေးမှ အသုံးပြုရာတွင် ထို loopback ပို့တ်ကို SSH ဖြင့် forward လုပ်ပါ (သို့မဟုတ် tailnet/VPN ကို အသုံးပြုပြီး တန်နယ် လျော့ချနိုင်သည်)။

## ပုံမှန် VPN/tailnet တပ်ဆင်မှုများ (agent တည်ရှိရာ)

SSH tunnel က အဲဒီ connection ကို Gateway chạy နေတဲ့ remote machine ရဲ့ port 18789 ဆီကို forward လုပ်ပေးပါတယ်။ **Gateway host** ကို “agent နေတဲ့နေရာ” လို့ စဉ်းစားနိုင်ပါတယ်။
sessions, auth profiles, channels နဲ့ state တွေကို အဲဒီ host က ပိုင်ဆိုင်ပါတယ်။

### 1. tailnet အတွင်း အမြဲလည်ပတ်နေသော Gateway (VPS သို့မဟုတ် အိမ်ဆာဗာ)

Gateway ကို အမြဲတမ်းရှိနေသော ဟို့စ် ပေါ်တွင် လည်ပတ်စေပြီး **Tailscale** သို့မဟုတ် SSH ဖြင့် ဝင်ရောက်ပါ။

- **အကောင်းဆုံး UX:** `gateway.bind: "loopback"` ကို ထိန်းသိမ်းပြီး Control UI အတွက် **Tailscale Serve** ကို အသုံးပြုပါ။
- **Fallback:** loopback ကို ထိန်းသိမ်းပြီး ဝင်ရောက်လိုသည့် မည်သည့် စက်မှမဆို SSH တန်နယ် ဖွင့်ပါ။
- **ဥပမာများ:** [exe.dev](/install/exe-dev) (လွယ်ကူသော VM) သို့မဟုတ် [Hetzner](/install/hetzner) (ထုတ်လုပ်မှု VPS)။

သင့် လပ်တော့ အမြဲ အိပ်နေတတ်သော်လည်း agent ကို အမြဲလည်ပတ်စေလိုသည့်အခါ အကောင်းဆုံး ဖြစ်သည်။

### 2. အိမ်ရှိ desktop သည် Gateway ကို လည်ပတ်ပြီး လပ်တော့သည် အဝေးမှ ထိန်းချုပ်ခြင်း

သင့် laptop/desktop (နဲ့ nodes) တွေက အဲဒီ host ကို ချိတ်ဆက်ပါတယ်။ laptop က agent ကို **မ chạy ပါဘူး**။

- macOS အက်ပ်၏ **Remote over SSH** မုဒ် (Settings → General → “OpenClaw runs”) ကို အသုံးပြုပါ။
- အက်ပ်က တန်နယ်ကို ဖွင့်လှစ်ပြီး စီမံခန့်ခွဲပေးသဖြင့် WebChat + ကျန်းမာရေး စစ်ဆေးမှုများကို “အလိုအလျောက် အလုပ်လုပ်” စေပါသည်။

လုပ်ဆောင်ချက်လမ်းညွှန်: [macOS remote access](/platforms/mac/remote)။

### 3. လပ်တော့သည် Gateway ကို လည်ပတ်ပြီး အခြား စက်များမှ အဝေးမှ ဝင်ရောက်ခြင်း

Gateway ကို ဒေသတွင်း ထားရှိထားပြီး လုံခြုံစွာ ထုတ်ဖော်ပါ။

- အခြား စက်များမှ လပ်တော့ သို့ SSH တန်နယ် ချိတ်ဆက်ပါ၊ သို့မဟုတ်
- Control UI အတွက် Tailscale Serve ကို အသုံးပြုပြီး Gateway ကို loopback-only အဖြစ် ထားရှိပါ။

လမ်းညွှန်: [Tailscale](/gateway/tailscale) နှင့် [Web overview](/web)။

## အမိန့် စီးဆင်းပုံ (ဘယ်မှာ ဘာလည်ပတ်သလဲ)

remote အနေနဲ့ ချိတ်ဆက်တာပါ။ gateway service တစ်ခုက state + channels ကို ပိုင်ဆိုင်ပါတယ်။

စီးဆင်းပုံ ဥပမာ (Telegram → node):

- Telegram မက်ဆေ့ချ်သည် **Gateway** သို့ ရောက်ရှိသည်။
- Gateway သည် **agent** ကို လည်ပတ်ပြီး node tool ကို ခေါ်မည်/မခေါ်မည် ဆုံးဖြတ်သည်။
- Gateway သည် Gateway WebSocket (`node.*` RPC) ဖြင့် **node** ကို ခေါ်သည်။
- Node က ရလဒ်ကို ပြန်ပို့ပြီး Gateway သည် Telegram သို့ ပြန်လည် တုံ့ပြန်သည်။

မှတ်ချက်များ:

- **နိုဒ်များသည် gateway ဝန်ဆောင်မှုကို မလည်ပတ်ပါ။** သီးခြားပရိုဖိုင်များကို ရည်ရွယ်ချက်ရှိစွာ လည်ပတ်စေခြင်း မဟုတ်ပါက ဟို့စ် တစ်ခုလျှင် gateway တစ်ခုသာ လည်ပတ်သင့်သည် ([Multiple gateways](/gateway/multiple-gateways) ကို ကြည့်ပါ)။
- macOS အက်ပ်၏ “node mode” သည် Gateway WebSocket ပေါ်ရှိ node client တစ်ခုသာ ဖြစ်သည်။

## SSH တန်နယ် (CLI + ကိရိယာများ)

အဝေးမှ Gateway WS သို့ ဒေသတွင်း တန်နယ် တစ်ခု ဖန်တီးပါ:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

တန်နယ် ဖွင့်ထားပြီးနောက်—

- `openclaw health` နှင့် `openclaw status --deep` သည် `ws://127.0.0.1:18789` မှတဆင့် အဝေးမှ gateway ကို ရောက်ရှိနိုင်ပါသည်။
- လိုအပ်ပါက `openclaw gateway {status,health,send,agent,call}` သည် `--url` ဖြင့် forward လုပ်ထားသော URL ကိုလည်း ဦးတည်နိုင်ပါသည်။

nodes တွေက peripherals ဖြစ်ပါတယ်။
မှတ်ချက်: `18789` ကို သင့် config ထဲက `gateway.port` (သို့မဟုတ် `--port`/`OPENCLAW_GATEWAY_PORT`) နဲ့ အစားထိုးပါ။
မှတ်ချက်: `--url` ကို ပေးလိုက်တဲ့အခါ CLI က config သို့မဟုတ် environment credentials ကို fallback မလုပ်ပါဘူး။ `--token` သို့မဟုတ် `--password` ကို အတိအကျ ထည့်ပါ။

## CLI အဝေးမှ မူလတန်ဖိုးများ

CLI အမိန့်များက မူလတန်ဖိုးအဖြစ် အသုံးပြုစေရန် အဝေးမှ ပစ်မှတ်ကို သိမ်းဆည်းနိုင်ပါသည်။

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

gateway သည် loopback-only ဖြစ်ပါက URL ကို `ws://127.0.0.1:18789` တွင် ထားရှိပြီး SSH တန်နယ်ကို အရင်ဖွင့်ပါ။

## SSH ဖြင့် Chat UI

credentials ကို အတိအကျ မပေးထားရင် error ဖြစ်ပါတယ်။ The SwiftUI chat UI connects directly to the Gateway WebSocket.

- `18789` ကို SSH ဖြင့် forward လုပ်ပြီး (အထက်ပါအတိုင်း) client များကို `ws://127.0.0.1:18789` သို့ ချိတ်ဆက်ပါ။
- macOS တွင် တန်နယ်ကို အလိုအလျောက် စီမံပေးသော အက်ပ်၏ “Remote over SSH” မုဒ်ကို ဦးစားပေးပါ။

## macOS အက်ပ် “Remote over SSH”

macOS မီနူးဘား အက်ပ်သည် အဆုံးမှ အဆုံးထိ တူညီသော တပ်ဆင်မှုကို မောင်းနှင်နိုင်ပါသည် (အဝေးမှ အခြေအနေ စစ်ဆေးမှုများ၊ WebChat နှင့် Voice Wake forwarding)။

လုပ်ဆောင်ချက်လမ်းညွှန်: [macOS remote access](/platforms/mac/remote)။

## လုံခြုံရေး စည်းမျဉ်းများ (remote/VPN)

အကျဉ်းချုပ် — **လိုအပ်ကြောင်း သေချာမထားမချင်း Gateway ကို loopback-only အဖြစ် ထားပါ**။

- **Loopback + SSH/Tailscale Serve** သည် အလုံခြုံဆုံး မူလတန်ဖိုး ဖြစ်သည် (အများပြည်သူထံ မထုတ်ဖော်)။
- **Loopback မဟုတ်သော bind များ** (`lan`/`tailnet`/`custom`၊ သို့မဟုတ် loopback မရနိုင်သည့်အခါ `auto`) တွင် auth token/စကားဝှက်များကို မဖြစ်မနေ အသုံးပြုရပါမည်။
- `gateway.remote.token` သည် အဝေးမှ CLI ခေါ်ဆိုမှုများအတွက် **သာလျှင်** ဖြစ်ပြီး ဒေသတွင်း auth ကို **မဖွင့်ပေးပါ**။
- `gateway.remote.tlsFingerprint` သည် `wss://` ကို အသုံးပြုသည့်အခါ အဝေးမှ TLS လက်မှတ်ကို pin လုပ်ပေးပါသည်။
- **Tailscale Serve** can authenticate via identity headers when `gateway.auth.allowTailscale: true`.
  Set it to `false` if you want tokens/passwords instead.
- ဘရောက်ဇာ ထိန်းချုပ်မှုကို အော်ပရေးတာ ဝင်ရောက်မှုကဲ့သို့ ကိုင်တွယ်ပါ — tailnet-only + ရည်ရွယ်ချက်ရှိသော node pairing။

အသေးစိတ်: [Security](/gateway/security)။
