---
summary: "Gateway ကို ရှာဖွေရန် node discovery နှင့် transports (Bonjour, Tailscale, SSH)"
read_when:
  - Bonjour discovery/advertising ကို အကောင်အထည်ဖော်ခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း
  - အဝေးမှ ချိတ်ဆက်မှု မုဒ်များ (direct vs SSH) ကို ချိန်ညှိခြင်း
  - အဝေးမှ node များအတွက် node discovery + pairing ကို ဒီဇိုင်းဆွဲခြင်း
title: "Discovery နှင့် Transports"
---

# Discovery & transports

OpenClaw တွင် မျက်နှာပြင်ပေါ်တွင် ဆင်တူသလို မြင်ရသော်လည်း သီးခြားပြဿနာ နှစ်ခု ရှိသည် —

1. **Operator remote control**: အခြားနေရာတွင် လည်ပတ်နေသော gateway ကို ထိန်းချုပ်သည့် macOS menu bar app။
2. **Node pairing**: iOS/Android (နှင့် အနာဂတ် node များ) မှ gateway ကို ရှာဖွေပြီး လုံခြုံစွာ pairing ပြုလုပ်ခြင်း။

ဒီဇိုင်းရည်မှန်းချက်မှာ network discovery/advertising အားလုံးကို **Node Gateway** (`openclaw gateway`) အတွင်းတွင်သာ ထားရှိပြီး client များ (mac app, iOS) ကို အသုံးပြုသူ (consumer) အဖြစ်သာထားရန် ဖြစ်သည်။

## Terms

- **Gateway**: a single long-running gateway process that owns state (sessions, pairing, node registry) and runs channels. Most setups use one per host; isolated multi-gateway setups are possible.
- **Gateway WS (control plane)**: ပုံမှန်အားဖြင့် `127.0.0.1:18789` ပေါ်တွင်ရှိသော WebSocket endpoint ဖြစ်ပြီး `gateway.bind` မှတစ်ဆင့် LAN/tailnet သို့ bind လုပ်နိုင်သည်။
- **Direct WS transport**: LAN/tailnet သို့ မျက်နှာမူထားသော Gateway WS endpoint (SSH မလိုအပ်)။
- **SSH transport (fallback)**: SSH မှတစ်ဆင့် `127.0.0.1:18789` ကို forward လုပ်၍ အဝေးမှ ထိန်းချုပ်ခြင်း။
- **Legacy TCP bridge (deprecated/removed)**: node transport အဟောင်း ( [Bridge protocol](/gateway/bridge-protocol) ကို ကြည့်ပါ) ဖြစ်ပြီး discovery အတွက် မကြော်ငြာတော့ပါ။

Protocol အသေးစိတ်များ —

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## “direct” နှင့် SSH နှစ်မျိုးလုံးကို ထိန်းသိမ်းထားရသည့် အကြောင်းရင်း

- **Direct WS** သည် တစ်ခုတည်းသော network အတွင်းနှင့် tailnet အတွင်းတွင် အကောင်းဆုံး UX ကို ပေးနိုင်သည် —
  - Bonjour ဖြင့် LAN အတွင်း auto-discovery
  - pairing tokens နှင့် ACLs များကို gateway က ပိုင်ဆိုင်သည်
  - shell access မလိုအပ်ဘဲ protocol surface ကို တင်းကျပ်စွာ စစ်ဆေးနိုင်သည်
- **SSH** သည် အမြဲတမ်း အသုံးပြုနိုင်သော fallback ဖြစ်သည် —
  - SSH access ရှိသည့် မည်သည့်နေရာတွင်မဆို အလုပ်လုပ်နိုင်သည် (မဆိုင်သော network များအကြားတောင်)
  - multicast/mDNS ပြဿနာများကို ကျော်လွှားနိုင်သည်
  - SSH အပြင် အဝင် port အသစ်များ မလိုအပ်ပါ

## Discovery inputs (client များက gateway ကို ဘယ်လို သိလာသလဲ)

### 1. Bonjour / mDNS (LAN အတွက်သာ)

Bonjour is best-effort and does not cross networks. It is only used for “same LAN” convenience.

Target direction —

- **gateway** သည် ၎င်း၏ WS endpoint ကို Bonjour မှတစ်ဆင့် ကြော်ငြာသည်။
- client များသည် browse လုပ်၍ “gateway ရွေးချယ်ပါ” စာရင်းကို ပြသပြီး ရွေးချယ်ထားသော endpoint ကို သိမ်းဆည်းသည်။

Troubleshooting နှင့် beacon အသေးစိတ်များကို [Bonjour](/gateway/bonjour) တွင် ကြည့်ပါ။

#### Service beacon အသေးစိတ်များ

- Service types —
  - `_openclaw-gw._tcp` (gateway transport beacon)
- TXT keys (လျှို့ဝှက်မဟုတ်) —
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (သို့မဟုတ် ကြော်ငြာထားသည့် အရာ)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (TLS ကို ဖွင့်ထားသည့်အခါသာ)
  - `gatewayTlsSha256=<sha256>` (TLS ဖွင့်ထားပြီး fingerprint ရရှိနိုင်သည့်အခါသာ)
  - `canvasPort=18793` (default canvas host port; `/__openclaw__/canvas/` ကို ဝန်ဆောင်မှုပေးသည်)
  - `cliPath=<path>` (optional; runnable `openclaw` entrypoint သို့မဟုတ် binary ၏ absolute path)
  - `tailnetDns=<magicdns>` (optional hint; Tailscale ရရှိနိုင်သည့်အခါ auto-detected)

Disable/override —

- `OPENCLAW_DISABLE_BONJOUR=1` သည် advertising ကို ပိတ်ထားသည်။
- `gateway.bind` ကို `~/.openclaw/openclaw.json` အတွင်းတွင် Gateway bind mode ကို ထိန်းချုပ်ရန် အသုံးပြုသည်။
- `OPENCLAW_SSH_PORT` သည် TXT တွင် ကြော်ငြာသည့် SSH port ကို override လုပ်သည် (default 22)။
- `OPENCLAW_TAILNET_DNS` သည် `tailnetDns` hint (MagicDNS) ကို ထုတ်ပြန်သည်။
- `OPENCLAW_CLI_PATH` သည် ကြော်ငြာထားသော CLI path ကို override လုပ်သည်။

### 2. Tailnet (network အကြား)

For London/Vienna style setups, Bonjour won’t help. The recommended “direct” target is:

- Tailscale MagicDNS name (အကြိုက်ဆုံး) သို့မဟုတ် တည်ငြိမ်သော tailnet IP ဖြစ်သည်။

gateway သည် Tailscale အောက်တွင် လည်ပတ်နေသည်ကို ရှာဖွေနိုင်ပါက client များအတွက် optional hint အဖြစ် `tailnetDns` ကို ထုတ်ပြန်ပေးသည် (wide-area beacons များအပါအဝင်)။

### 3. Manual / SSH target

တိုက်ရိုက်လမ်းကြောင်း မရှိသည့်အခါ (သို့မဟုတ် direct ကို ပိတ်ထားသည့်အခါ) client များသည် loopback gateway port ကို forward လုပ်ခြင်းဖြင့် SSH မှတစ်ဆင့် အမြဲချိတ်ဆက်နိုင်သည်။

[Remote access](/gateway/remote) ကို ကြည့်ပါ။

## Transport ရွေးချယ်ခြင်း (client policy)

အကြံပြုထားသော client အပြုအမူ —

1. paired လုပ်ထားပြီး reachable ဖြစ်သော direct endpoint ရှိပါက ထိုအရာကို အသုံးပြုပါ။
2. မဟုတ်ပါက Bonjour မှ LAN အတွင်း gateway ကို တွေ့ရှိပါက “Use this gateway” ကို တစ်ချက်နှိပ်ရွေးချယ်နိုင်အောင် ပြသပြီး direct endpoint အဖြစ် သိမ်းဆည်းပါ။
3. မဟုတ်ပါက tailnet DNS/IP ကို ပြင်ဆင်ထားပါက direct ကို စမ်းကြည့်ပါ။
4. ထို့နောက် မဖြစ်ပါက SSH သို့ fallback လုပ်ပါ။

## Pairing + auth (direct transport)

gateway သည် node/client ဝင်ရောက်ခွင့်အတွက် source of truth ဖြစ်သည်။

- pairing request များကို gateway အတွင်းတွင် ဖန်တီး/အတည်ပြု/ပယ်ချ လုပ်ဆောင်သည် ([Gateway pairing](/gateway/pairing) ကို ကြည့်ပါ)။
- gateway သည် အောက်ပါအရာများကို အကောင်အထည်ဖော်သည် —
  - auth (token / keypair)
  - scopes/ACLs (gateway သည် method အားလုံးအတွက် raw proxy မဟုတ်ပါ)
  - rate limits

## Component အလိုက် တာဝန်များ

- **Gateway**: discovery beacon များကို ကြော်ငြာခြင်း၊ pairing ဆုံးဖြတ်ချက်များကို ပိုင်ဆိုင်ခြင်း၊ WS endpoint ကို host လုပ်ခြင်း။
- **macOS app**: gateway ကို ရွေးချယ်ရန် ကူညီပေးခြင်း၊ pairing prompt များကို ပြသခြင်း၊ SSH ကို fallback အဖြစ်သာ အသုံးပြုခြင်း။
- **iOS/Android nodes**: အဆင်ပြေစေရန် Bonjour ကို browse လုပ်ပြီး paired လုပ်ထားသော Gateway WS သို့ ချိတ်ဆက်ခြင်း။
