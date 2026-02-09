---
summary: "Nodes — pairing, စွမ်းဆောင်ရည်များ, ခွင့်ပြုချက်များ နှင့် canvas/camera/screen/system အတွက် CLI အကူအညီများ"
read_when:
  - iOS/Android node များကို Gateway နှင့် pairing လုပ်သောအခါ
  - agent context အတွက် node canvas/camera ကို အသုံးပြုသောအခါ
  - node command အသစ်များ သို့မဟုတ် CLI helper များ ထည့်သွင်းသောအခါ
title: "Nodes"
---

# Nodes

**node** ဆိုသည်မှာ Gateway **WebSocket** (operators များနှင့် တူညီသော port) သို့ `role: "node"` ဖြင့် ချိတ်ဆက်ပြီး `node.invoke` မှတစ်ဆင့် command surface (ဥပမာ `canvas.*`, `camera.*`, `system.*`) ကို ဖော်ပြပေးသော companion device (macOS/iOS/Android/headless) တစ်ခု ဖြစ်ပါသည်။ Protocol အသေးစိတ်များ: [Gateway protocol](/gateway/protocol).

Legacy transport: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; မသုံးတော့/လက်ရှိ node များအတွက် ဖယ်ရှားပြီး)။

macOS သည် **node mode** ဖြင့်လည်း လည်ပတ်နိုင်သည် — menubar app သည် Gateway ၏ WS server သို့ ချိတ်ဆက်ပြီး ၎င်း၏ local canvas/camera command များကို node အဖြစ် ဖော်ပြပေးသည် (ထို့ကြောင့် `openclaw nodes …` သည် ဒီ Mac ကို ရည်ညွှန်း၍ အလုပ်လုပ်နိုင်သည်)။

မှတ်ချက်များ:

- 2. ၎င်းတို့သည် gateway service ကို မလုပ်ဆောင်ပါ။ 3. **WS nodes များသည် device pairing ကို အသုံးပြုသည်။** Nodes များသည် `connect` အချိန်တွင် device identity ကို တင်ပြပြီး Gateway သည် `role: node` အတွက် device pairing request ကို ဖန်တီးပေးသည်။
- Telegram/WhatsApp စသည့် မက်ဆေ့ချ်များသည် node များမဟုတ်ဘဲ **gateway** ပေါ်သို့သာ ရောက်ရှိပါသည်။
- Troubleshooting runbook: [/nodes/troubleshooting](/nodes/troubleshooting)

## Pairing + status

4. devices CLI (သို့မဟုတ် UI) မှတဆင့် approve လုပ်ပါ။ 5. Gateway ကို စက်တစ်လုံးပေါ်တွင် run လုပ်ထားပြီး အခြားစက်တစ်လုံးပေါ်တွင် command များကို execute လုပ်လိုပါက **node host** ကို အသုံးပြုပါ။

Quick CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

မှတ်ချက်များ:

- `nodes status` သည် node ကို **paired** အဖြစ် မှတ်သားပေးသည်၊ ၎င်း၏ device pairing role တွင် `node` ပါဝင်သောအခါ ဖြစ်သည်။
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) သည် gateway ပိုင်ဆိုင်သော သီးခြား node pairing store ဖြစ်ပြီး WS `connect` handshake ကို **မထိန်းချုပ်ပါ**။

## Remote node host (system.run)

Gateway ကို စက်တစ်လုံးပေါ်မှာ chạy ထားပြီး command တွေကို တခြားစက်တစ်လုံးပေါ်မှာ execute လုပ်ချင်ရင် **node host** ကို သုံးပါ။ 7. Gateway သည် loopback (`gateway.bind=loopback`, local mode တွင် default) သို့ bind လုပ်ထားပါက remote node hosts များသည် တိုက်ရိုက် connect မလုပ်နိုင်ပါ။

### ဘယ်အရာ ဘယ်နေရာမှာ လည်ပတ်သလဲ

- **Gateway host**: မက်ဆေ့ချ်များ လက်ခံခြင်း၊ model ကို လည်ပတ်ခြင်း၊ tool calls များကို လမ်းကြောင်းချခြင်း။
- **Node host**: node စက်ပေါ်တွင် `system.run`/`system.which` ကို အကောင်အထည်ဖော်ခြင်း။
- **Approvals**: `~/.openclaw/exec-approvals.json` မှတစ်ဆင့် node host ပေါ်တွင် အတည်ပြုစစ်ဆေးထားသည်။

### Node host ကို စတင်ခြင်း (foreground)

Node စက်ပေါ်တွင်:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSH tunnel ဖြင့် Remote gateway (loopback bind)

8. SSH tunnel တစ်ခု ဖန်တီးပြီး node host ကို tunnel ၏ local end သို့ ချိတ်ဆက်ပါ။ SSH tunnel တစ်ခု ဖန်တီးပြီး node host ကို tunnel ရဲ့ local end ဆီ ညွှန်ပါ။

ဥပမာ (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

မှတ်ချက်များ:

- token သည် gateway config ထဲရှိ `gateway.auth.token` ဖြစ်ပါသည် (gateway host ပေါ်ရှိ `~/.openclaw/openclaw.json`)။
- `openclaw node run` သည် auth အတွက် `OPENCLAW_GATEWAY_TOKEN` ကို ဖတ်ပါသည်။

### Node host ကို စတင်ခြင်း (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Pair + name

Gateway host ပေါ်တွင်:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Naming options:

- `openclaw node run` / `openclaw node install` ပေါ်ရှိ `--display-name` (node ပေါ်ရှိ `~/.openclaw/node.json` တွင် သိမ်းဆည်းထားသည်)။
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway override)။

### Command များကို allowlist ထည့်ခြင်း

Exec approvals တွေက **node host တစ်ခုချင်းစီအလိုက်** ဖြစ်ပါတယ်။ Add allowlist entries from the gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals များကို node host ပေါ်ရှိ `~/.openclaw/exec-approvals.json` တွင် သိမ်းဆည်းထားပါသည်။

### Exec ကို node သို့ ညွှန်ပြခြင်း

Defaults ကို configure လုပ်ရန် (gateway config):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

သို့မဟုတ် session တစ်ခုချင်းစီအလိုက်:

```
/exec host=node security=allowlist node=<id-or-name>
```

တစ်ကြိမ် သတ်မှတ်ပြီးပါက `exec` call များထဲမှ `host=node` ပါဝင်သော call များသည် node host ပေါ်တွင် လည်ပတ်ပါသည် (node allowlist/approvals အရ အကန့်အသတ်ရှိသည်)။

ဆက်စပ်:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Command များကို ခေါ်ယူအသုံးပြုခြင်း

Low-level (raw RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

အများဆုံးအသုံးများသော “agent ကို MEDIA attachment ပေးခြင်း” workflow များအတွက် higher-level helper များလည်း ရှိပါသည်။

## Screenshots (canvas snapshots)

Node သည် Canvas (WebView) ကို ပြသနေပါက `canvas.snapshot` သည် `{ format, base64 }` ကို ပြန်ပေးပါသည်။

CLI helper (temp file သို့ ရေးပြီး `MEDIA:<path>` ကို ပရင့်ထုတ်ပါသည်):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas controls

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

မှတ်ချက်များ:

- `canvas present` သည် URLs သို့မဟုတ် local file paths (`--target`) ကို လက်ခံပြီး တည်နေရာချရန် optional `--x/--y/--width/--height` ကိုပါ လက်ခံပါသည်။
- `canvas eval` သည် inline JS (`--js`) သို့မဟုတ် positional arg ကို လက်ခံပါသည်။

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

မှတ်ချက်များ:

- A2UI v0.8 JSONL ကိုသာ ပံ့ပိုးပါသည် (v0.9/createSurface ကို ငြင်းပယ်ပါသည်)။

## Photos + videos (node camera)

Photos (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Video clips (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

မှတ်ချက်များ:

- `canvas.*` နှင့် `camera.*` အတွက် node သည် **foregrounded** ဖြစ်ရပါမည် (background call များသည် `NODE_BACKGROUND_UNAVAILABLE` ကို ပြန်ပေးပါသည်)။
- Clip ကြာချိန်ကို base64 payload အလွန်ကြီးမားမှု မဖြစ်စေရန် (လက်ရှိ `<= 60s`) အတွင်း ကန့်သတ်ထားပါသည်။
- Android သည် ဖြစ်နိုင်သည့်အခါ `CAMERA`/`RECORD_AUDIO` ခွင့်ပြုချက်များကို မေးမြန်းပါမည်; ခွင့်မပြုပါက `*_PERMISSION_REQUIRED` ဖြင့် မအောင်မြင်ပါသည်။

## Screen recordings (nodes)

Nodes expose `screen.record` (mp4). ဥပမာ —

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

မှတ်ချက်များ:

- `screen.record` သည် node app ကို foreground ထားရန် လိုအပ်ပါသည်။
- Android တွင် မှတ်တမ်းတင်မီ system screen-capture prompt ကို ပြပါမည်။
- Screen recording များကို `<= 60s` အတွင်း ကန့်သတ်ထားပါသည်။
- `--no-audio` သည် microphone capture ကို ပိတ်ပါသည် (iOS/Android တွင် ပံ့ပိုးထားပြီး macOS သည် system capture audio ကို အသုံးပြုပါသည်)။
- မျက်နှာပြင်များ အများအပြား ရှိပါက `--screen <index>` ကို အသုံးပြုပြီး display ကို ရွေးချယ်ပါ။

## Location (nodes)

Settings တွင် Location ကို ဖွင့်ထားပါက Nodes များသည် `location.get` ကို ဖော်ပြပေးပါသည်။

CLI helper:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

မှတ်ချက်များ:

- Location သည် **မူလအတိုင်း ပိတ်ထားပါသည်**။
- “Always” သည် system permission လိုအပ်ပြီး background fetch သည် အကောင်းဆုံးကြိုးစားမှုဖြင့်သာ လုပ်ဆောင်ပါသည်။
- Response တွင် lat/lon, accuracy (မီတာဖြင့်) နှင့် timestamp ပါဝင်ပါသည်။

## SMS (Android nodes)

အသုံးပြုသူက **SMS** permission ကို ခွင့်ပြုပြီး စက်တွင် telephony ပံ့ပိုးမှု ရှိပါက Android nodes များသည် `sms.send` ကို ဖော်ပြနိုင်ပါသည်။

Low-level invoke:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

မှတ်ချက်များ:

- Capability ကို ကြော်ငြာမပြုမီ Android စက်ပေါ်တွင် permission prompt ကို လက်ခံရပါမည်။
- Telephony မပါသော Wi‑Fi only စက်များသည် `sms.send` ကို မကြော်ငြာပါ။

## System commands (node host / mac node)

13. headless node host သည် `system.run`, `system.which`, နှင့် `system.execApprovals.get/set` ကို expose လုပ်ပေးသည်။
14. macOS node mode တွင် `system.run` သည် macOS app (Settings → Exec approvals) ထဲရှိ exec approvals များဖြင့် gated လုပ်ထားသည်။

ဥပမာများ:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

မှတ်ချက်များ:

- `system.run` သည် payload အတွင်း stdout/stderr/exit code ကို ပြန်ပေးပါသည်။
- `system.notify` သည် macOS app ပေါ်ရှိ notification permission အခြေအနေကို လေးစားလိုက်နာပါသည်။
- `system.run` သည် `--cwd`, `--env KEY=VAL`, `--command-timeout`, နှင့် `--needs-screen-recording` ကို ပံ့ပိုးပါသည်။
- `system.notify` သည် `--priority <passive|active|timeSensitive>` နှင့် `--delivery <system|overlay|auto>` ကို ပံ့ပိုးပါသည်။
- macOS node များသည် `PATH` override များကို ပယ်ချပါသည်; headless node host များသည် node host PATH ကို prepend လုပ်ထားသည့်အခါမှသာ `PATH` ကို လက်ခံပါသည်။
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals).
  Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.
- Headless node host တွင် `system.run` သည် exec approvals (`~/.openclaw/exec-approvals.json`) ဖြင့် ထိန်းချုပ်ထားပါသည်။

## Exec node binding

17. ၎င်းသည် `exec host=node` အတွက် default node ကို သတ်မှတ်ပေးပြီး (agent တစ်ခုချင်းစီအလိုက် override လုပ်နိုင်သည်)။
    This sets the default node for `exec host=node` (and can be overridden per agent).

Global default:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

မည်သည့် node မဆို ခွင့်ပြုရန် unset လုပ်ရန်:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Permissions map

Nodes များသည် `node.list` / `node.describe` ထဲတွင် permission name (ဥပမာ `screenRecording`, `accessibility`) ကို key အဖြစ် အသုံးပြုထားသော `permissions` map တစ်ခုကို ပါဝင်စေနိုင်ပြီး boolean တန်ဖိုးများ (`true` = granted) ပါဝင်ပါသည်။

## Headless node host (cross-platform)

19. ၎င်းသည် Linux/Windows ပေါ်တွင် သို့မဟုတ် server တစ်ခု၏ ဘေးတွင် minimal node တစ်ခု run လုပ်ရန် အသုံးဝင်သည်။ This is useful on Linux/Windows
    or for running a minimal node alongside a server.

စတင်ရန်:

```bash
openclaw node run --host <gateway-host> --port 18789
```

မှတ်ချက်များ:

- Pairing သည် မဖြစ်မနေ လိုအပ်ပါသည် (Gateway သည် node approval prompt ကို ပြပါမည်)။
- Node host သည် ၎င်း၏ node id, token, display name နှင့် gateway connection info များကို `~/.openclaw/node.json` တွင် သိမ်းဆည်းထားပါသည်။
- Exec approvals များကို `~/.openclaw/exec-approvals.json` မှတစ်ဆင့် local အဖြစ် ထိန်းချုပ်ထားပါသည်
  ([Exec approvals](/tools/exec-approvals) ကို ကြည့်ပါ)။
- On macOS, the headless node host prefers the companion app exec host when reachable and falls
  back to local execution if the app is unavailable. 22. OS permissions များသည် multi-level ဖြစ်သည်။
- Gateway WS သည် TLS ကို အသုံးပြုပါက `--tls` / `--tls-fingerprint` ကို ထည့်ပါ။

## Mac node mode

- macOS menubar app သည် Gateway WS server သို့ node အဖြစ် ချိတ်ဆက်ပါသည် (ထို့ကြောင့် `openclaw nodes …` သည် ဒီ Mac ကို ရည်ညွှန်း၍ အလုပ်လုပ်နိုင်ပါသည်)။
- Remote mode တွင် app သည် Gateway port အတွက် SSH tunnel ကို ဖွင့်ပြီး `localhost` သို့ ချိတ်ဆက်ပါသည်။
