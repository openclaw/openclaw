---
summary: "Exec approvals၊ allowlist များနှင့် sandbox မှ လွတ်မြောက်ရန် အတည်ပြုမေးခွန်းများ"
read_when:
  - Exec approvals သို့မဟုတ် allowlist များကို ဖွဲ့စည်းပြင်ဆင်နေစဉ်
  - macOS အက်ပ်တွင် exec approval UX ကို အကောင်အထည်ဖော်နေစဉ်
  - sandbox မှ လွတ်မြောက်ရန် အတည်ပြုမေးခွန်းများနှင့် ၎င်းတို့၏ သက်ရောက်မှုများကို ပြန်လည်သုံးသပ်နေစဉ်
title: "Exec Approvals"
---

# Exec approvals

21. Exec approvals သည် sandboxed agent တစ်ခုအား အမှန်တကယ် host (`gateway` သို့မဟုတ် `node`) ပေါ်တွင် command များ chạy ခွင့်ပြုရန် အသုံးပြုသော **companion app / node host guardrail** ဖြစ်ပါသည်။ 22. ၎င်းကို လုံခြုံရေး interlock တစ်ခုလို ထင်မြင်နိုင်ပါသည် — policy + allowlist + (ရွေးချယ်နိုင်သော) user approval အားလုံး သဘောတူမှသာ command များကို ခွင့်ပြုပါသည်။
22. Exec approvals များသည် tool policy နှင့် elevated gating အပေါ် **ထပ်ဆောင်း** ဖြစ်ပါသည် (`elevated` ကို `full` အဖြစ် သတ်မှတ်ထားပါက approvals ကို ကျော်ဖြတ်ပါသည်)။
23. Effective policy သည် `tools.exec.*` နှင့် approvals defaults တို့အနက် **ပိုမိုတင်းကြပ်သော** တန်ဖိုးဖြစ်ပါသည်; approvals field တစ်ခုကို မထည့်ထားပါက `tools.exec` တန်ဖိုးကို အသုံးပြုပါသည်။

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

25. Allowlists များသည် **agent တစ်ခုချင်းစီအလိုက်** ဖြစ်ပါသည်။ 26. Agent များ အများအပြား ရှိပါက macOS app တွင် သင်ပြင်ဆင်နေသော agent ကို ပြောင်းလဲပါ။ 27. Patterns များသည် **case-insensitive glob matches** ဖြစ်ပါသည်။
26. Patterns များသည် **binary paths** သို့ resolve ဖြစ်ရပါမည် (basename-only entries များကို လျစ်လျူရှုပါသည်)။
27. Legacy `agents.default` entries များကို load လုပ်စဉ် `agents.main` သို့ ပြောင်းရွှေ့ပါသည်။

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

30. **Auto-allow skill CLIs** ကို ဖွင့်ထားသောအခါ သိရှိထားသော skills များမှ reference လုပ်ထားသော executables များကို nodes (macOS node သို့မဟုတ် headless node host) တွင် allowlisted အဖြစ် သတ်မှတ်ပါသည်။ 31. ၎င်းသည် Gateway RPC မှတဆင့် skill bin စာရင်းကို ရယူရန် `skills.bins` ကို အသုံးပြုပါသည်။ 32. တင်းကျပ်သော manual allowlists ကို လိုလားပါက ဤအရာကို ပိတ်ထားပါ။

## Safe bins (stdin-only)

33. `tools.exec.safeBins` သည် **stdin-only** binaries များ (ဥပမာ `jq`) ကို အနည်းငယ် သတ်မှတ်ထားပြီး explicit allowlist entries မလိုအပ်ဘဲ allowlist mode ဖြင့် chạy နိုင်ပါသည်။ 34. Safe bins များသည် positional file args နှင့် path-like tokens များကို ငြင်းပယ်သဖြင့် incoming stream ပေါ်တွင်သာ လုပ်ဆောင်နိုင်ပါသည်။
34. Shell chaining နှင့် redirections များကို allowlist mode တွင် auto-allow မလုပ်ပါ။

36. Shell chaining (`&&`, `||`, `;`) ကို top-level segment တစ်ခုချင်းစီက allowlist (safe bins သို့မဟုတ် skill auto-allow အပါအဝင်) ကို ပြည့်မီပါက ခွင့်ပြုပါသည်။ 37. Redirections များကို allowlist mode တွင် မထောက်ပံ့သေးပါ။
37. Command substitution (`$()` / backticks) ကို allowlist parsing အတွင်း ငြင်းပယ်ပါသည်၊ double quotes အတွင်းပါ ပါဝင်သော်လည်း ဖြစ်ပါသည်; literal `$()` စာသား လိုအပ်ပါက single quotes ကို အသုံးပြုပါ။

Default safe bins— `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`။

## Control UI editing

39. Defaults၊ agent တစ်ခုချင်းစီအလိုက် overrides နှင့် allowlists များကို ပြင်ဆင်ရန် **Control UI → Nodes → Exec approvals** ကတ်ကို အသုံးပြုပါ။ 40. Scope (Defaults သို့မဟုတ် agent တစ်ခု) ကို ရွေးချယ်ပြီး policy ကို ပြင်ဆင်ပါ၊ allowlist patterns များကို ထည့်/ဖယ် လုပ်ပြီးနောက် **Save** ကို နှိပ်ပါ။ 41. စာရင်းကို စနစ်တကျ ထိန်းသိမ်းနိုင်ရန် UI တွင် pattern တစ်ခုချင်းစီအတွက် **last used** metadata ကို ပြသပါသည်။

42. Target selector သည် **Gateway** (local approvals) သို့မဟုတ် **Node** ကို ရွေးချယ်ပေးပါသည်။ 43. Nodes များသည် `system.execApprovals.get/set` ကို advertise လုပ်ထားရပါမည် (macOS app သို့မဟုတ် headless node host)။
43. Node တစ်ခုက exec approvals ကို မ advertise လုပ်သေးပါက ၎င်း၏ local `~/.openclaw/exec-approvals.json` ကို တိုက်ရိုက် ပြင်ဆင်ပါ။

CLI— `openclaw approvals` သည် gateway သို့မဟုတ် node ကို ပြင်ဆင်နိုင်ပါသည်
([Approvals CLI](/cli/approvals) ကို ကြည့်ပါ)။

## Approval flow

45. Prompt လိုအပ်သောအခါ gateway သည် operator clients များသို့ `exec.approval.requested` ကို broadcast လုပ်ပါသည်။
46. Control UI နှင့် macOS app တို့သည် `exec.approval.resolve` ဖြင့် ဖြေရှင်းပြီး gateway သည် ခွင့်ပြုထားသော request ကို node host သို့ ပို့ပေးပါသည်။

47. Approvals လိုအပ်သောအခါ exec tool သည် approval id နှင့်အတူ ချက်ချင်း ပြန်လည်အဖြေ ပေးပါသည်။ 48. နောက်ပိုင်း system events (`Exec finished` / `Exec denied`) များနှင့် ဆက်စပ်ရန် ထို id ကို အသုံးပြုပါ။ 49. Timeout မတိုင်မီ ဆုံးဖြတ်ချက် မရောက်ရှိပါက ထို request ကို approval timeout အဖြစ် သတ်မှတ်ပြီး denial reason အဖြစ် ပြသပါသည်။

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

50. Exec approval prompts များကို မည်သည့် chat channel (plugin channels အပါအဝင်) သို့မဆို ပို့နိုင်ပြီး `/approve` ဖြင့် ခွင့်ပြုနိုင်ပါသည်။ ဤအရာသည် ပုံမှန် outbound delivery pipeline ကို အသုံးပြုသည်။

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

node မှ event ကို report လုပ်ပြီးနောက် ဤအရာများကို agent ၏ session သို့ post လုပ်သည်။
Gateway-host exec approvals များသည် command ပြီးဆုံးသည့်အခါ (နှင့် threshold ထက်ပိုကြာပါက ရွေးချယ်စရာအဖြစ်) lifecycle events တူညီစွာ ထုတ်လွှတ်သည်။
Approval-gated exec များသည် လွယ်ကူစွာ ချိတ်ဆက်နိုင်ရန် ဤ message များတွင် approval id ကို `runId` အဖြစ် ပြန်လည်အသုံးပြုသည်။

## Implications

- **full** သည် အလွန်အစွမ်းထက်သောကြောင့် ဖြစ်နိုင်လျှင် allowlist များကို ဦးစားပေးပါ။
- **ask** သည် လုပ်ငန်းစဉ်ကို မြန်ဆန်စေပြီး အတည်ပြုမှုတွင် သင်ပါဝင်နေစေရန် ကူညီပါသည်။
- အေးဂျင့်အလိုက် allowlist များသည် အေးဂျင့်တစ်ခု၏ အတည်ပြုချက်များကို အခြားအေးဂျင့်များသို့ မပေါက်ကြားစေရန် ကာကွယ်ပါသည်။
- Approvals များသည် **authorized senders** ထံမှ host exec request များအတွက်သာ သက်ဆိုင်သည်။ Unauthorized senders များသည် `/exec` ကို အသုံးပြု၍ မရပါ။
- `/exec security=full` သည် authorized operators များအတွက် session-level အဆင်ပြေမှုတစ်ခုဖြစ်ပြီး design အရ approvals များကို ကျော်လွှားထားသည်။
  Host exec ကို အပြည့်အဝပိတ်ရန် approvals security ကို `deny` သို့မဟုတ် tool policy မှတဆင့် `exec` tool ကို deny လုပ်ပါ။

Related—

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
