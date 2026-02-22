---
summary: "Bonjour/mDNS ရှာဖွေတွေ့ရှိမှု + ဒီဘဂ်လုပ်ခြင်း (Gateway beacons, clients နှင့် ပုံမှန်တွေ့ရသော မအောင်မြင်မှုအခြေအနေများ)"
read_when:
  - macOS/iOS တွင် Bonjour ရှာဖွေတွေ့ရှိမှု ပြဿနာများကို ဒီဘဂ်လုပ်နေချိန်
  - mDNS service types, TXT records သို့မဟုတ် discovery UX ကို ပြောင်းလဲနေချိန်
title: "Bonjour ရှာဖွေတွေ့ရှိမှု"
---

# Bonjour / mDNS ရှာဖွေတွေ့ရှိမှု

၎င်းသည် best‑effort ဖြစ်ပြီး SSH သို့မဟုတ် Tailnet-based connectivity ကို **အစားထိုး မလုပ်ပါ**။ Node နှင့် gateway တို့သည် မတူညီသော networks များပေါ်တွင် ရှိပါက multicast mDNS သည် boundary ကို မကျော်နိုင်ပါ။

## Tailscale ပေါ်တွင် Wide‑area Bonjour (Unicast DNS‑SD)

Tailscale ပေါ်မှ **unicast DNS‑SD** (“Wide‑Area Bonjour”) ကို အသုံးပြု၍ တူညီသော discovery UX ကို ထိန်းထားနိုင်ပါသည်။ OpenClaw သည် မည်သည့် discovery domain မဆို ထောက်ပံ့ပါသည်။ `openclaw.internal.` သည် ဥပမာတစ်ခုသာ ဖြစ်ပါသည်။

အဆင့်မြင့် လုပ်ဆောင်ရမည့် အချက်များ:

1. gateway host ပေါ်တွင် DNS server တစ်ခုကို run လုပ်ပါ (Tailnet မှတစ်ဆင့် ဝင်ရောက်နိုင်ရမည်)။
2. သီးသန့် zone တစ်ခုအောက်တွင် `_openclaw-gw._tcp` အတွက် DNS‑SD records များကို publish လုပ်ပါ
   (ဥပမာ: `openclaw.internal.`)။
3. သင်ရွေးချယ်ထားသော domain ကို clients များ (iOS အပါအဝင်) မှ ထို DNS server ဖြင့် resolve လုပ်စေရန်
   Tailscale **split DNS** ကို configure လုပ်ပါ။

OpenClaw supports any discovery domain; `openclaw.internal.` is just an example.
iOS/Android nodes များသည် `local.` နှင့် သင် configure လုပ်ထားသော wide‑area domain နှစ်ခုလုံးကို browse လုပ်ပါသည်။

### Gateway config (အကြံပြု)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### DNS server ကို တစ်ကြိမ်တည်း တပ်ဆင်ခြင်း (gateway host)

```bash
openclaw dns setup --apply
```

၎င်းသည် CoreDNS ကို ထည့်သွင်းတပ်ဆင်ပြီး အောက်ပါအတိုင်း configure လုပ်ပေးပါသည်:

- gateway ၏ Tailscale interfaces များပေါ်တွင်သာ port 53 ကို listen လုပ်ရန်
- `~/.openclaw/dns/<domain>.db` မှ သင်ရွေးချယ်ထားသော domain (ဥပမာ: `openclaw.internal.`) ကို serve လုပ်ရန်

tailnet ချိတ်ဆက်ထားသော စက်တစ်လုံးမှ validate လုပ်ပါ:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS ဆက်တင်များ

Tailscale admin console အတွင်းတွင်:

- gateway ၏ tailnet IP ကို ညွှန်ပြသော nameserver တစ်ခုကို (UDP/TCP 53) ထည့်ပါ။
- သင်၏ discovery domain သည် ထို nameserver ကို အသုံးပြုစေရန် split DNS ကို ထည့်ပါ။

clients များသည် tailnet DNS ကို လက်ခံပြီးပါက iOS nodes များသည် multicast မလိုအပ်ဘဲ
သင်၏ discovery domain အတွင်းရှိ `_openclaw-gw._tcp` ကို browse လုပ်နိုင်ပါသည်။

### Gateway listener လုံခြုံရေး (အကြံပြု)

The Gateway WS port (default `18789`) binds to loopback by default. For LAN/tailnet
access, bind explicitly and keep auth enabled.

tailnet‑only setup များအတွက်:

- `~/.openclaw/openclaw.json` ထဲတွင် `gateway.bind: "tailnet"` ကို သတ်မှတ်ပါ။
- Gateway ကို restart လုပ်ပါ (သို့မဟုတ် macOS menubar app ကို restart လုပ်ပါ)။

## ကြော်ငြာသူ

Gateway တစ်ခုတည်းသာ `_openclaw-gw._tcp` ကို ကြော်ငြာပါသည်။

## Service types

- `_openclaw-gw._tcp` — gateway transport beacon (macOS/iOS/Android nodes များမှ အသုံးပြုသည်)။

## TXT keys (လျှို့ဝှက်မဟုတ်သော အညွှန်းများ)

Gateway သည် UI flows များကို အဆင်ပြေစေရန် လျှို့ဝှက်မဟုတ်သော အညွှန်းအသေးစားများကို ကြော်ငြာပါသည်:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (TLS ကို ဖွင့်ထားသောအခါသာ)
- `gatewayTlsSha256=<sha256>` (TLS ကို ဖွင့်ထားပြီး fingerprint ရရှိနိုင်သောအခါသာ)
- `canvasPort=<port>` (canvas host ကို ဖွင့်ထားသောအခါသာ; မူလ `18793`)
- `sshPort=<port>` (override မလုပ်ထားပါက မူလ 22)
- `transport=gateway`
- `cliPath=<path>` (optional; runnable `openclaw` entrypoint သို့ absolute path)
- `tailnetDns=<magicdns>` (optional; Tailnet ရရှိနိုင်သည့်အခါ အညွှန်း)

## macOS တွင် ဒီဘဂ်လုပ်ခြင်း

အသုံးဝင်သော built‑in ကိရိယာများ:

- instances များကို browse လုပ်ရန်:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- instance တစ်ခုကို resolve လုပ်ရန် (`<instance>` ကို အစားထိုးပါ):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

browse လုပ်ခြင်း အလုပ်လုပ်ပေမယ့် resolve မလုပ်နိုင်ပါက အများအားဖြင့် LAN policy သို့မဟုတ်
mDNS resolver ပြဿနာတစ်ခုကို ကြုံတွေ့နေရခြင်း ဖြစ်ပါသည်။

## Gateway logs တွင် ဒီဘဂ်လုပ်ခြင်း

The Gateway writes a rolling log file (printed on startup as
`gateway log file: ...`). Look for `bonjour:` lines, especially:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## iOS node တွင် ဒီဘဂ်လုပ်ခြင်း

iOS node သည် `NWBrowser` ကို အသုံးပြုပြီး `_openclaw-gw._tcp` ကို ရှာဖွေတွေ့ရှိပါသည်။

logs ကို ဖမ်းယူရန်:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → reproduce → **Copy**

log အတွင်းတွင် browser state ပြောင်းလဲမှုများနှင့် result‑set ပြောင်းလဲမှုများ ပါဝင်ပါသည်။

## ပုံမှန်တွေ့ရသော မအောင်မြင်မှုအခြေအနေများ

- **Bonjour သည် ကွန်ယက်များကို မဖြတ်ကျော်နိုင်ပါ**: Tailnet သို့မဟုတ် SSH ကို အသုံးပြုပါ။
- **Multicast ကို ပိတ်ထားခြင်း**: Wi‑Fi ကွန်ယက်အချို့တွင် mDNS ကို ပိတ်ထားပါသည်။
- **Sleep / interface churn**: macOS သည် အချိန်အနည်းငယ်အတွင်း mDNS ရလဒ်များကို ကျသွားစေနိုင်ပါသည်; ပြန်လည်ကြိုးစားပါ။
- **Browse works but resolve fails**: keep machine names simple (avoid emojis or
  punctuation), then restart the Gateway. Service instance name သည် host name မှ ဆင်းသက်လာသောကြောင့် အလွန်ရှုပ်ထွေးသော နာမည်များသည် resolver အချို့ကို ရှုပ်ထွေးစေနိုင်ပါသည်။

## Escaped instance names (`\032`)

Bonjour/DNS‑SD သည် service instance names များအတွင်း byte များကို ဒသမ `\DDD`
အစီအစဉ်များအဖြစ် မကြာခဏ escape လုပ်ပါသည် (ဥပမာ space များသည် `\032` ဖြစ်လာပါသည်)။

- ၎င်းသည် protocol အဆင့်တွင် ပုံမှန်ဖြစ်ပါသည်။
- UIs များသည် ပြသရန်အတွက် decode လုပ်သင့်ပါသည် (iOS သည် `BonjourEscapes.decode` ကို အသုံးပြုပါသည်)။

## ပိတ်ခြင်း / ဖွဲ့စည်းပြင်ဆင်ခြင်း

- `OPENCLAW_DISABLE_BONJOUR=1` သည် advertising ကို ပိတ်ပါသည် (legacy: `OPENCLAW_DISABLE_BONJOUR`)။
- `~/.openclaw/openclaw.json` ထဲရှိ `gateway.bind` သည် Gateway bind mode ကို ထိန်းချုပ်ပါသည်။
- `OPENCLAW_SSH_PORT` သည် TXT တွင် ကြော်ငြာထားသော SSH port ကို override လုပ်ပါသည် (legacy: `OPENCLAW_SSH_PORT`)။
- `OPENCLAW_TAILNET_DNS` သည် TXT တွင် MagicDNS အညွှန်းကို publish လုပ်ပါသည် (legacy: `OPENCLAW_TAILNET_DNS`)။
- `OPENCLAW_CLI_PATH` သည် ကြော်ငြာထားသော CLI path ကို override လုပ်ပါသည် (legacy: `OPENCLAW_CLI_PATH`)။

## ဆက်စပ်စာရွက်စာတမ်းများ

- Discovery policy နှင့် transport ရွေးချယ်မှု: [Discovery](/gateway/discovery)
- Node pairing + approvals: [Gateway pairing](/gateway/pairing)
