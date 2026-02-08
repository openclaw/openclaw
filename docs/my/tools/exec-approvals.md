---
summary: "Exec approvals၊ allowlist များနှင့် sandbox မှ လွတ်မြောက်ရန် အတည်ပြုမေးခွန်းများ"
read_when:
  - Exec approvals သို့မဟုတ် allowlist များကို ဖွဲ့စည်းပြင်ဆင်နေစဉ်
  - macOS အက်ပ်တွင် exec approval UX ကို အကောင်အထည်ဖော်နေစဉ်
  - sandbox မှ လွတ်မြောက်ရန် အတည်ပြုမေးခွန်းများနှင့် ၎င်းတို့၏ သက်ရောက်မှုများကို ပြန်လည်သုံးသပ်နေစဉ်
title: "Exec Approvals"
x-i18n:
  source_path: tools/exec-approvals.md
  source_hash: 66630b5d79671dd4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:24Z
---

# Exec approvals

Exec approvals သည် sandbox အတွင်းရှိ agent ကို အမှန်တကယ်သော host ပေါ်တွင် command များကို လုပ်ဆောင်ခွင့်ပေးရန် အသုံးပြုသော **companion app / node host guardrail** ဖြစ်သည်
(`gateway` သို့မဟုတ် `node`)။ လုံခြုံရေး အပြန်အလှန်တားဆီးကိရိယာတစ်ခုလို စဉ်းစားနိုင်ပါသည်—
policy + allowlist + (လိုအပ်ပါက) အသုံးပြုသူအတည်ပြုချက် အားလုံး သဘောတူမှသာ command များကို ခွင့်ပြုပါသည်။
Exec approvals သည် tool policy နှင့် elevated gating အပေါ် **ထပ်ဆောင်း** ဖြစ်ပါသည်
(elevated ကို `full` ဟု သတ်မှတ်ထားပါက approvals ကို ကျော်သွားမည်)။
အကျိုးသက်ရောက်သော policy သည် `tools.exec.*` နှင့် approvals defaults တို့အနက် **ပိုမိုတင်းကျပ်သော** ဘက်ကို ယူပါသည်။
approvals field တစ်ခုခု မပါရှိပါက `tools.exec` တန်ဖိုးကို အသုံးပြုပါသည်။

companion app UI ကို **မရရှိနိုင်ပါက** prompt လိုအပ်သော request မည်သည့်အရာမဆို
**ask fallback** (ပုံမှန်အားဖြင့်: deny) ဖြင့် ဖြေရှင်းပါသည်။

## Where it applies

Exec approvals ကို execution host ပေါ်တွင် local အဖြစ် အတင်းအကျပ် သတ်မှတ်ထားပါသည်—

- **gateway host** → gateway စက်ပေါ်ရှိ `openclaw` process
- **node host** → node runner (macOS companion app သို့မဟုတ် headless node host)

macOS ခွဲခြားပုံ—

- **node host service** သည် `system.run` ကို local IPC ဖြင့် **macOS app** သို့ ပို့ဆောင်ပါသည်။
- **macOS app** သည် approvals ကို အတည်ပြုပြီး UI context အတွင်း command ကို လုပ်ဆောင်ပါသည်။

## Settings and storage

Approvals များကို execution host ပေါ်ရှိ local JSON ဖိုင်တစ်ခုတွင် သိမ်းဆည်းထားပါသည်—

`~/.openclaw/exec-approvals.json`

ဥပမာ schema—

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Policy knobs

### Security (`exec.security`)

- **deny**: host exec request အားလုံးကို ပိတ်ပင်ပါ။
- **allowlist**: allowlist ထဲတွင် ပါသော command များကိုသာ ခွင့်ပြုပါ။
- **full**: အားလုံးကို ခွင့်ပြုပါ (elevated နှင့် တူညီသည်)။

### Ask (`exec.ask`)

- **off**: ဘယ်တော့မှ မေးမြန်းမပြုလုပ်ပါ။
- **on-miss**: allowlist မကိုက်ညီသည့်အခါသာ မေးမြန်းပါ။
- **always**: command တစ်ခုချင်းစီတိုင်းတွင် မေးမြန်းပါ။

### Ask fallback (`askFallback`)

prompt လိုအပ်သော်လည်း UI ကို မရောက်ရှိနိုင်ပါက fallback က ဆုံးဖြတ်ပါသည်—

- **deny**: ပိတ်ပင်ပါ။
- **allowlist**: allowlist ကိုက်ညီလျှင်သာ ခွင့်ပြုပါ။
- **full**: ခွင့်ပြုပါ။

## Allowlist (per agent)

Allowlists များသည် **အေးဂျင့်တစ်ခုချင်းစီအလိုက်** ဖြစ်ပါသည်။ အေးဂျင့်များ အများအပြား ရှိပါက
macOS app ထဲတွင် ပြင်ဆင်လိုသည့် အေးဂျင့်ကို ပြောင်းရွေးပါ။
pattern များသည် **case မခွဲသော glob match** များဖြစ်ပါသည်။
pattern များသည် **binary path များ** အဖြစ် ဖြေရှင်းရပါမည် (basename သာပါသော entry များကို လျစ်လျူရှုပါသည်)။
Legacy `agents.default` entry များကို load လုပ်ချိန်တွင် `agents.main` သို့ ပြောင်းရွှေ့ပါသည်။

ဥပမာများ—

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

allowlist entry တစ်ခုချင်းစီတွင် အောက်ပါအချက်များကို မှတ်တမ်းတင်ထားပါသည်—

- **id** UI identity အတွက် အသုံးပြုသော stable UUID (ရွေးချယ်နိုင်)
- **last used** timestamp
- **last used command**
- **last resolved path**

## Auto-allow skill CLIs

**Auto-allow skill CLIs** ကို ဖွင့်ထားပါက သိပြီးသား Skills များမှ ကိုးကားထားသော executable များကို
node များပေါ်တွင် (macOS node သို့မဟုတ် headless node host) allowlisted အဖြစ် သတ်မှတ်ပါသည်။
၎င်းသည် Gateway RPC မှတဆင့် `skills.bins` ကို အသုံးပြုပြီး skill bin စာရင်းကို ရယူပါသည်။
manual allowlist များကို တင်းကျပ်စွာ အသုံးပြုလိုပါက ဤအရာကို ပိတ်ထားပါ။

## Safe bins (stdin-only)

`tools.exec.safeBins` သည် **stdin-only** binary များ၏ စာရင်းအသေးတစ်ခုကို သတ်မှတ်ထားပါသည်
(ဥပမာ `jq`)။
Safe bins များသည် positional file args နှင့် path ပုံစံ token များကို ငြင်းပယ်သောကြောင့်
ဝင်လာသော stream ပေါ်တွင်သာ လုပ်ဆောင်နိုင်ပါသည်။
Shell chaining နှင့် redirection များကို allowlist mode တွင် auto-allow မပြုလုပ်ပါ။

Shell chaining (`&&`, `||`, `;`) ကို
top-level segment တစ်ခုချင်းစီက allowlist ကို ဖြည့်ဆည်းပါက
(safe bins သို့မဟုတ် skill auto-allow ပါဝင်အောင်) ခွင့်ပြုပါသည်။
Redirection များကို allowlist mode တွင် ဆက်လက် မထောက်ပံ့ပါ။
Command substitution (`$()` / backticks) ကို allowlist parsing အတွင်း
double quotes အတွင်းပါဝင်နေပါကပါ ငြင်းပယ်ပါသည်။
literal `$()` စာသားလိုအပ်ပါက single quotes ကို အသုံးပြုပါ။

Default safe bins— `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`။

## Control UI editing

defaults၊ အေးဂျင့်အလိုက် override များနှင့် allowlist များကို ပြင်ဆင်ရန်
**Control UI → Nodes → Exec approvals** ကဒ်ကို အသုံးပြုပါ။
scope (Defaults သို့မဟုတ် အေးဂျင့်တစ်ခု) ကို ရွေးချယ်ပြီး policy ကို ချိန်ညှိကာ
allowlist pattern များကို ထည့်/ဖယ် ပြီးနောက် **Save** ကို နှိပ်ပါ။
UI တွင် pattern တစ်ခုချင်းစီအတွက် **last used** metadata ကို ပြသပေးသဖြင့်
စာရင်းကို သန့်ရှင်းစွာ ထိန်းသိမ်းနိုင်ပါသည်။

target selector သည် **Gateway** (local approvals) သို့မဟုတ် **Node** ကို ရွေးချယ်ပါသည်။
Node များသည် `system.execApprovals.get/set` ကို ကြော်ငြာထားရပါမည်
(macOS app သို့မဟုတ် headless node host)။
Node တစ်ခုက exec approvals ကို မကြော်ငြာသေးပါက
၎င်း၏ local `~/.openclaw/exec-approvals.json` ကို တိုက်ရိုက် ပြင်ဆင်ပါ။

CLI— `openclaw approvals` သည် gateway သို့မဟုတ် node ကို ပြင်ဆင်နိုင်ပါသည်
([Approvals CLI](/cli/approvals) ကို ကြည့်ပါ)။

## Approval flow

prompt လိုအပ်သည့်အခါ gateway သည် operator client များသို့ `exec.approval.requested` ကို broadcast လုပ်ပါသည်။
Control UI နှင့် macOS app သည် `exec.approval.resolve` ဖြင့် ဖြေရှင်းပြီးနောက်
gateway သည် အတည်ပြုထားသော request ကို node host သို့ ပို့ဆောင်ပါသည်။

approvals လိုအပ်ပါက exec tool သည် ချက်ချင်း approval id တစ်ခုနှင့် ပြန်လည်ပေးပို့ပါသည်။
နောက်ပိုင်း system events (`Exec finished` / `Exec denied`) နှင့် ဆက်စပ်ရန် ထို id ကို အသုံးပြုပါ။
timeout မတိုင်မီ ဆုံးဖြတ်ချက် မရောက်ရှိပါက
၎င်း request ကို approval timeout အဖြစ် သတ်မှတ်ပြီး deny အကြောင်းပြချက်အဖြစ် ပြသပါသည်။

confirmation dialog တွင် အောက်ပါအချက်များ ပါဝင်ပါသည်—

- command + args
- cwd
- agent id
- resolved executable path
- host + policy metadata

လုပ်ဆောင်ချက်များ—

- **Allow once** → ယခုချက်ချင်း လုပ်ဆောင်ပါ
- **Always allow** → allowlist ထဲသို့ ထည့်ပြီး လုပ်ဆောင်ပါ
- **Deny** → ပိတ်ပင်ပါ

## Approval forwarding to chat channels

exec approval prompt များကို မည်သည့် chat channel မဆို (plugin channel များအပါအဝင်) သို့ ပို့နိုင်ပြီး
`/approve` ဖြင့် အတည်ပြုနိုင်ပါသည်။
ဤအရာသည် ပုံမှန် outbound delivery pipeline ကို အသုံးပြုပါသည်။

Config—

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

chat တွင် ပြန်ကြားချက်—

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC flow

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Security မှတ်ချက်များ—

- Unix socket mode `0600`၊ token ကို `exec-approvals.json` တွင် သိမ်းဆည်းထားပါသည်။
- Same-UID peer စစ်ဆေးခြင်း။
- Challenge/response (nonce + HMAC token + request hash) နှင့် TTL အတို။

## System events

Exec lifecycle ကို system message များအဖြစ် ဖော်ပြပါသည်—

- `Exec running` (command သည် running notice threshold ကို ကျော်လွန်မှသာ)
- `Exec finished`
- `Exec denied`

ဤ message များကို node က event ကို အစီရင်ခံပြီးနောက် အေးဂျင့်၏ session သို့ ပို့ပါသည်။
Gateway-host exec approvals များသည် command ပြီးဆုံးချိန်တွင်
(နှင့် threshold ကို ကျော်လွန်လျှင် running အနေဖြင့်) တူညီသော lifecycle event များကို ထုတ်ပေးပါသည်။
Approval ဖြင့် တားဆီးထားသော exec များတွင်
ဤ message များ၏ `runId` အဖြစ် approval id ကို ပြန်လည်အသုံးပြုပါသည်။

## Implications

- **full** သည် အလွန်အစွမ်းထက်သောကြောင့် ဖြစ်နိုင်လျှင် allowlist များကို ဦးစားပေးပါ။
- **ask** သည် လုပ်ငန်းစဉ်ကို မြန်ဆန်စေပြီး အတည်ပြုမှုတွင် သင်ပါဝင်နေစေရန် ကူညီပါသည်။
- အေးဂျင့်အလိုက် allowlist များသည် အေးဂျင့်တစ်ခု၏ အတည်ပြုချက်များကို အခြားအေးဂျင့်များသို့ မပေါက်ကြားစေရန် ကာကွယ်ပါသည်။
- Approvals များသည် **authorized senders** မှ လာသော host exec request များအတွက်သာ သက်ရောက်ပါသည်။
  ခွင့်မပြုထားသော sender များသည် `/exec` ကို ထုတ်ပေးနိုင်ခြင်း မရှိပါ။
- `/exec security=full` သည် authorized operator များအတွက် session-level အဆင်ပြေမှုတစ်ခုဖြစ်ပြီး
  design အရ approvals ကို ကျော်သွားပါသည်။
  host exec ကို တင်းကျပ်စွာ ပိတ်ပင်လိုပါက approvals security ကို `deny` ဟု သတ်မှတ်ပါ
  သို့မဟုတ် tool policy ဖြင့် `exec` tool ကို deny ပြုလုပ်ပါ။

Related—

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
