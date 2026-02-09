---
summary: "Android အက်ပ် (နိုဒ်): ချိတ်ဆက်မှု runbook + Canvas/Chat/Camera"
read_when:
  - Android နိုဒ်ကို Pairing ပြုလုပ်ခြင်း သို့မဟုတ် ပြန်လည်ချိတ်ဆက်ခြင်း
  - Android Gateway ရှာဖွေတွေ့ရှိမှု သို့မဟုတ် auth ကို Debugging လုပ်ခြင်း
  - ကလိုင်ယင့်များအကြား Chat history တူညီမှုကို အတည်ပြုခြင်း
title: "Android အက်ပ်"
---

# Android အက်ပ် (Node)

## Support snapshot

- Role: companion node app (Android သည် Gateway ကို မဟို့စ်ပါ)။
- Gateway လိုအပ်မှု: လိုအပ်သည် (macOS, Linux, သို့မဟုတ် Windows via WSL2 တွင် run လုပ်ပါ)။
- Install: [Getting Started](/start/getting-started) + [Pairing](/gateway/pairing)။
- Gateway: [Runbook](/gateway) + [Configuration](/gateway/configuration)။
  - Protocols: [Gateway protocol](/gateway/protocol) (nodes + control plane)။

## System control

27. System control (launchd/systemd) ကို Gateway host ပေါ်တွင် ထားရှိထားပါသည်။ 28. [Gateway](/gateway) ကို ကြည့်ပါ။

## Connection Runbook

Android node app ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android သည် Gateway WebSocket (default `ws://<host>:18789`) သို့ တိုက်ရိုက်ချိတ်ဆက်ပြီး Gateway ပိုင် pairing ကို အသုံးပြုသည်။

### Prerequisites

- “master” စက်ပေါ်တွင် Gateway ကို run လုပ်နိုင်ရပါမည်။
- Android device/emulator မှ gateway WebSocket ကို ရောက်နိုင်ရပါမည် —
  - mDNS/NSD ပါသော LAN တူညီမှု **သို့မဟုတ်**
  - Wide-Area Bonjour / unicast DNS-SD (အောက်တွင်ကြည့်ပါ) ကို အသုံးပြုသော Tailscale tailnet တူညီမှု **သို့မဟုတ်**
  - Manual gateway host/port (fallback)
- Gateway စက်ပေါ်တွင် CLI (`openclaw`) ကို run လုပ်နိုင်ရပါမည် (သို့မဟုတ် SSH ဖြင့်)။

### 1. Gateway ကို စတင်ပါ

```bash
openclaw gateway --port 18789 --verbose
```

Logs တွင် အောက်ပါအတိုင်းတွေ့ရကြောင်း အတည်ပြုပါ —

- `listening on ws://0.0.0.0:18789`

Tailnet-only setup များအတွက် (Vienna ⇄ London အတွက် အကြံပြုထားသည်) gateway ကို tailnet IP သို့ bind လုပ်ပါ —

- Gateway ဟို့စ်ပေါ်ရှိ `~/.openclaw/openclaw.json` တွင် `gateway.bind: "tailnet"` ကို သတ်မှတ်ပါ။
- Gateway / macOS menubar app ကို ပြန်လည်စတင်ပါ။

### 2. Discovery ကို စစ်ဆေးပါ (optional)

Gateway စက်မှ —

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Debugging ဆိုင်ရာ မှတ်စုများ: [Bonjour](/gateway/bonjour)။

#### unicast DNS-SD ဖြင့် Tailnet (Vienna ⇄ London) discovery

29. Android NSD/mDNS discovery သည် network များကို မဖြတ်ကျော်နိုင်ပါ။ 30. သင့် Android node နှင့် gateway သည် မတူညီသော network များပေါ်တွင် ရှိသော်လည်း Tailscale ဖြင့် ချိတ်ဆက်ထားပါက Wide-Area Bonjour / unicast DNS-SD ကို အသုံးပြုပါ:

1. Gateway ဟို့စ်ပေါ်တွင် DNS-SD zone (ဥပမာ `openclaw.internal.`) ကို တည်ဆောက်ပြီး `_openclaw-gw._tcp` records များကို publish လုပ်ပါ။
2. သင်ရွေးချယ်ထားသော domain ကို ညွှန်ပြသည့် DNS server သို့ Tailscale split DNS ကို configure လုပ်ပါ။

အသေးစိတ်နှင့် CoreDNS config ဥပမာ: [Bonjour](/gateway/bonjour)။

### 3. Android မှ ချိတ်ဆက်ပါ

Android အက်ပ်အတွင်း —

- အက်ပ်သည် **foreground service** (persistent notification) ဖြင့် gateway ချိတ်ဆက်မှုကို ဆက်လက်အသက်ဝင်အောင် ထိန်းသိမ်းထားသည်။
- **Settings** ကို ဖွင့်ပါ။
- **Discovered Gateways** အောက်တွင် သင့် gateway ကို ရွေးပြီး **Connect** ကိုနှိပ်ပါ။
- mDNS ပိတ်ထားပါက **Advanced → Manual Gateway** (host + port) ကို အသုံးပြုပြီး **Connect (Manual)** ကိုနှိပ်ပါ။

ပထမဆုံး pairing အောင်မြင်ပြီးနောက် Android သည် launch 时 အလိုအလျောက် ပြန်လည်ချိတ်ဆက်မည် —

- Manual endpoint (enable လုပ်ထားပါက)၊ မဟုတ်ပါက
- နောက်ဆုံးတွေ့ရှိထားသော gateway (best-effort)။

### 4. Pairing ကို အတည်ပြုပါ (CLI)

Gateway စက်ပေါ်တွင် —

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Pairing အသေးစိတ်: [Gateway pairing](/gateway/pairing)။

### 5. Node ချိတ်ဆက်ထားကြောင်း စစ်ဆေးပါ

- Nodes status မှ —

  ```bash
  openclaw nodes status
  ```

- Gateway မှ —

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Chat + history

Android node ၏ Chat sheet သည် gateway ၏ **primary session key** (`main`) ကို အသုံးပြုသဖြင့် WebChat နှင့် အခြား client များနှင့် history နှင့် replies များကို မျှဝေပါသည် —

- History: `chat.history`
- Send: `chat.send`
- Push updates (best-effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + camera

#### Gateway Canvas Host (web content အတွက် အကြံပြုထားသည်)

Agent မှ disk ပေါ်တွင် တည်းဖြတ်နိုင်သော HTML/CSS/JS အစစ်အမှန်ကို node တွင် ပြလိုပါက node ကို Gateway canvas host သို့ ညွှန်ပြပါ။

မှတ်ချက်: nodes များသည် `canvasHost.port` (default `18793`) ပေါ်ရှိ standalone canvas host ကို အသုံးပြုသည်။

1. Gateway ဟို့စ်ပေါ်တွင် `~/.openclaw/workspace/canvas/index.html` ကို ဖန်တီးပါ။

2. Node ကို ၎င်းသို့ သွားလာစေပါ (LAN) —

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (optional): စက်နှစ်ခုလုံး Tailscale ပေါ်တွင်ရှိပါက `.local` အစား MagicDNS name သို့မဟုတ် tailnet IP ကို အသုံးပြုပါ၊ ဥပမာ `http://<gateway-magicdns>:18793/__openclaw__/canvas/`။

31. ဤ server သည် HTML ထဲသို့ live-reload client ကို inject လုပ်ပြီး ဖိုင်ပြောင်းလဲမှုများရှိပါက reload လုပ်ပါသည်။
32. A2UI host ကို `http://<gateway-host>:18793/__openclaw__/a2ui/` တွင် ရရှိနိုင်ပါသည်။

Canvas commands (foreground only):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (use `{"url":""}` or `{"url":"/"}` to return to the default scaffold). 34. `canvas.snapshot` သည် `{ format, base64 }` ကို ပြန်ပေးပါသည် (`format="jpeg"` သည် default ဖြစ်ပါသည်)။
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy alias)

Camera commands (foreground only; permission ဖြင့်ကန့်သတ်ထားသည်):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Parameters နှင့် CLI helpers များအတွက် [Camera node](/nodes/camera) ကိုကြည့်ပါ။
