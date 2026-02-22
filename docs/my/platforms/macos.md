---
summary: "OpenClaw macOS အတူတကွ အသုံးပြုသော အက်ပ် (မီနူးဘား + Gateway broker)"
read_when:
  - macOS အက်ပ် အင်္ဂါရပ်များကို အကောင်အထည်ဖော်နေချိန်
  - macOS တွင် Gateway lifecycle သို့မဟုတ် node bridging ကို ပြောင်းလဲနေချိန်
title: "macOS အက်ပ်"
---

# OpenClaw macOS Companion (မီနူးဘား + gateway broker)

macOS app သည် OpenClaw အတွက် **menu‑bar companion** ဖြစ်သည်။ ၎င်းသည် permissions များကို ပိုင်ဆိုင်ပြီး Gateway ကို locally (launchd သို့မဟုတ် manual) စီမံခန့်ခွဲ/ချိတ်ဆက်ကာ macOS capabilities များကို agent အတွက် node အဖြစ် ထုတ်ဖော်ပေးသည်။

## ၎င်း၏ လုပ်ဆောင်ချက်များ

- မီနူးဘားတွင် native အသိပေးချက်များနှင့် အခြေအနေကို ပြသသည်။
- TCC prompts (Notifications, Accessibility, Screen Recording, Microphone,
  Speech Recognition, Automation/AppleScript) များကို ကိုင်တွယ်ပိုင်ဆိုင်သည်။
- Gateway ကို လည်ပတ်စေခြင်း သို့မဟုတ် ချိတ်ဆက်ခြင်း (local သို့မဟုတ် remote) ပြုလုပ်သည်။
- macOS သီးသန့် ကိရိယာများ (Canvas, Camera, Screen Recording, `system.run`) ကို ဖော်ထုတ်ပေးသည်။
- **remote** မုဒ်တွင် local node host service ကို စတင်လည်ပတ်စေပြီး (launchd)၊ **local** မုဒ်တွင် ရပ်တန့်စေသည်။
- UI automation အတွက် **PeekabooBridge** ကို ရွေးချယ်အနေဖြင့် ဟို့စ်လုပ်ဆောင်ပေးနိုင်သည်။
- တောင်းဆိုပါက npm/pnpm မှတစ်ဆင့် global CLI (`openclaw`) ကို ထည့်သွင်းပေးသည် (Gateway runtime အတွက် bun ကို မအကြံပြုပါ)။

## Local နှင့် remote မုဒ်များ

- **Local** (မူလ): အက်ပ်သည် လည်ပတ်နေသော local Gateway ရှိပါက ချိတ်ဆက်ပြီး၊ မရှိပါက `openclaw gateway install` ဖြင့် launchd service ကို ဖွင့်ပေးသည်။
- **Remote**: app သည် Gateway သို့ SSH/Tailscale ဖြင့် ချိတ်ဆက်ပြီး local process ကို ဘယ်တော့မှ မစတင်ပါ။
  Remote Gateway က ဒီ Mac ကို ရောက်နိုင်ရန် app သည် local **node host service** ကို စတင်သည်။
  App သည် Gateway ကို child process အဖြစ် မစတင်ပါ။

## Launchd ထိန်းချုပ်မှု

App သည် per‑user LaunchAgent ကို `bot.molt.gateway` အဖြစ် စီမံခန့်ခွဲသည်
(or `bot.molt.<profile>`` when using `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.\*\` still unloads).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Named profile ဖြင့် chạy သောအခါ label ကို `bot.molt.<profile>` ဖြင့် အစားထိုးပါ။\` when running a named profile.

LaunchAgent မထည့်သွင်းရသေးပါက အက်ပ်မှ ဖွင့်ပါ သို့မဟုတ်
`openclaw gateway install` ကို လည်ပတ်ပါ။

## Node စွမ်းဆောင်ရည်များ (mac)

macOS app သည် node အဖြစ် ကိုယ်စားပြု ပြသသည်။ အများဆုံးအသုံးပြုသော command များ:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

node သည် `permissions` map ကို အစီရင်ခံပြီး အေးဂျင့်များက ခွင့်ပြုထားသည့် အရာများကို ဆုံးဖြတ်နိုင်စေသည်။

Node service + app IPC:

- headless node host service လည်ပတ်နေစဉ် (remote မုဒ်) Gateway WS သို့ node အဖြစ် ချိတ်ဆက်သည်။
- `system.run` သည် local Unix socket မှတစ်ဆင့် macOS အက်ပ် (UI/TCC context) အတွင်းတွင် အကောင်အထည်ဖော်ပြီး prompt များနှင့် output များကို အက်ပ်အတွင်းပဲ ထားရှိသည်။

Diagram (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec approvals (system.run)

`system.run` ကို macOS app ထဲရှိ **Exec approvals** (Settings → Exec approvals) ဖြင့် ထိန်းချုပ်သည်။
Security + ask + allowlist များကို Mac ပေါ်တွင် local အဖြစ် သိမ်းဆည်းထားသည်:

```
~/.openclaw/exec-approvals.json
```

ဥပမာ—

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

မှတ်ချက်များ—

- `allowlist` entry များသည် ဖြေရှင်းပြီးသော binary လမ်းကြောင်းများအတွက် glob patterns ဖြစ်သည်။
- prompt တွင် “Always Allow” ကို ရွေးချယ်ပါက ထိုအမိန့်ကို allowlist ထဲသို့ ထည့်သွင်းသည်။
- `system.run` environment overrides များကို စစ်ထုတ်ပြီး (`PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT` ကို ဖယ်ရှားသည်) ထို့နောက် အက်ပ်၏ environment နှင့် ပေါင်းစည်းသည်။

## Deep links

အက်ပ်သည် ဒေသခံ လုပ်ဆောင်ချက်များအတွက် `openclaw://` URL scheme ကို မှတ်ပုံတင်ထားသည်။

### `openclaw://agent`

Gateway `agent` တောင်းဆိုမှုကို လှုံ့ဆော်သည်။

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Query parameters—

- `message` (လိုအပ်)
- `sessionKey` (ရွေးချယ်နိုင်)
- `thinking` (ရွေးချယ်နိုင်)
- `deliver` / `to` / `channel` (ရွေးချယ်နိုင်)
- `timeoutSeconds` (ရွေးချယ်နိုင်)
- `key` (unattended မုဒ် key — ရွေးချယ်နိုင်)

လုံခြုံရေး—

- `key` မပါရှိပါက အက်ပ်သည် အတည်ပြုချက် တောင်းခံသည်။
- တရားဝင် `key` ရှိပါက run ကို unattended အဖြစ် လုပ်ဆောင်သည် (ကိုယ်ပိုင် automation များအတွက် ရည်ရွယ်သည်)။

## Onboarding flow (ပုံမှန်)

1. **OpenClaw.app** ကို ထည့်သွင်းပြီး လည်ပတ်ပါ။
2. ခွင့်ပြုချက် စစ်ဆေးစာရင်း (TCC prompts) ကို ပြီးမြောက်အောင် ဆောင်ရွက်ပါ။
3. **Local** မုဒ် အလုပ်လုပ်နေပြီး Gateway လည်ပတ်နေကြောင်း သေချာပါစေ။
4. terminal မှ အသုံးပြုလိုပါက CLI ကို ထည့်သွင်းပါ။

## Build & dev workflow (native)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (သို့မဟုတ် Xcode)
- အက်ပ်ကို package ပြုလုပ်ရန်: `scripts/package-mac-app.sh`

## Debug gateway connectivity (macOS CLI)

macOS အက်ပ်ကို မဖွင့်ဘဲ၊ အက်ပ်က အသုံးပြုသည့် Gateway WebSocket handshake နှင့် discovery
logic တူညီသည့် လုပ်ငန်းစဉ်များကို စမ်းသပ်ရန် debug CLI ကို အသုံးပြုပါ။

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Connect options—

- `--url <ws://host:port>`: config ကို override လုပ်ရန်
- `--mode <local|remote>`: config မှ ဖြေရှင်းရန် (မူလ: config သို့မဟုတ် local)
- `--probe`: အသစ်စက်စက် health probe ကို အတင်းအကျပ် လုပ်ရန်
- `--timeout <ms>`: request timeout (မူလ: `15000`)
- `--json`: diffing အတွက် structured output

Discovery options—

- `--include-local`: “local” အဖြစ် စစ်ထုတ်ခံရမည့် gateway များကို ပါဝင်စေရန်
- `--timeout <ms>`: စုစုပေါင်း discovery အချိန်ပြတင်းပေါက် (မူလ: `2000`)
- `--json`: diffing အတွက် structured output

အကြံပြုချက်: macOS အက်ပ်၏ discovery pipeline (NWBrowser + tailnet DNS‑SD fallback) သည်
Node CLI ၏ `dns-sd` အခြေပြု discovery နှင့် ကွာခြားမှုရှိ/မရှိကို ကြည့်ရန်
`openclaw gateway discover --json` နှင့် နှိုင်းယှဉ်ပါ။

## Remote connection plumbing (SSH tunnels)

macOS အက်ပ်ကို **Remote** မုဒ်တွင် လည်ပတ်သည့်အခါ၊ local UI အစိတ်အပိုင်းများသည်
remote Gateway နှင့် localhost ပေါ်တွင် ရှိသကဲ့သို့ ဆက်သွယ်နိုင်ရန် SSH tunnel ကို ဖွင့်ပေးသည်။

### Control tunnel (Gateway WebSocket port)

- **ရည်ရွယ်ချက်:** health checks, status, Web Chat, config နှင့် အခြား control‑plane ခေါ်ဆိုမှုများ။
- **Local port:** Gateway port (မူလ `18789`), အမြဲတမ်း တည်ငြိမ်သည်။
- **Remote port:** remote ဟို့စ်ပေါ်ရှိ တူညီသော Gateway port။
- **အပြုအမူ:** random local port မသုံးပါ; ကျန်းမာသော tunnel ရှိနေပါက ပြန်လည်အသုံးပြု သို့မဟုတ် လိုအပ်ပါက ပြန်စတင်သည်။
- **SSH ပုံစံ:** BatchMode +
  ExitOnForwardFailure + keepalive options ပါသော `ssh -N -L <local>:127.0.0.1:<remote>`။
- **IP reporting:** SSH tunnel သည် loopback ကို အသုံးပြုသောကြောင့် gateway သည် node IP ကို `127.0.0.1` အဖြစ် မြင်မည် ဖြစ်သည်။ Client IP အမှန်ကို ပြသလိုပါက **Direct (ws/wss)** transport ကို အသုံးပြုပါ ([macOS remote access](/platforms/mac/remote) ကို ကြည့်ပါ)။

setup လုပ်ရန် အဆင့်များအတွက် [macOS remote access](/platforms/mac/remote) ကိုကြည့်ပါ။ protocol အချက်အလက်များအတွက် [Gateway protocol](/gateway/protocol) ကိုကြည့်ပါ။

## ဆက်စပ် စာတမ်းများ

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
