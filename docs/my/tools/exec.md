---
summary: "Exec ကိရိယာ၏ အသုံးပြုပုံ၊ stdin မုဒ်များနှင့် TTY ပံ့ပိုးမှု"
read_when:
  - exec ကိရိယာကို အသုံးပြုခြင်း သို့မဟုတ် ပြုပြင်ပြောင်းလဲခြင်း
  - stdin သို့မဟုတ် TTY အပြုအမူများကို အမှားရှာဖွေခြင်း
title: "Exec ကိရိယာ"
x-i18n:
  source_path: tools/exec.md
  source_hash: 3b32238dd8dce93d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:27Z
---

# Exec ကိရိယာ

workspace အတွင်း shell အမိန့်များကို လည်ပတ်စေပါသည်။ `process` မှတဆင့် ရှေ့တန်း (foreground) + နောက်ခံ (background) လည်ပတ်မှုကို ပံ့ပိုးပါသည်။
`process` ကို ခွင့်မပြုထားပါက `exec` သည် synchronous အဖြစ် လည်ပတ်ပြီး `yieldMs`/`background` ကို လျစ်လျူရှုပါသည်။
နောက်ခံ ဆက်ရှင်များကို အေးဂျင့်တစ်ခုချင်းစီအလိုက် ကန့်သတ်ထားပြီး `process` သည် အေးဂျင့်တူညီသူမှ ဆက်ရှင်များကိုသာ မြင်နိုင်ပါသည်။

## ပါရာမီတာများ

- `command` (လိုအပ်သည်)
- `workdir` (မူလတန်ဖိုးမှာ cwd)
- `env` (ကီး/တန်ဖိုး အစားထိုးမှုများ)
- `yieldMs` (မူလ 10000): အချိန်နှောင့်ပြီးနောက် အလိုအလျောက် နောက်ခံသို့ ပြောင်းသည်
- `background` (bool): ချက်ချင်း နောက်ခံသို့ ပြောင်းသည်
- `timeout` (စက္ကန့်၊ မူလ 1800): သက်တမ်းကုန်လျှင် ရပ်တန့်စေသည်
- `pty` (bool): ရနိုင်ပါက pseudo-terminal ဖြင့် လည်ပတ်သည် (TTY သာလိုအပ်သော CLI များ၊ coding agents၊ terminal UI များ)
- `host` (`sandbox | gateway | node`): လည်ပတ်မည့်နေရာ
- `security` (`deny | allowlist | full`): `gateway`/`node` အတွက် အကောင်အထည်ဖော်မှု မုဒ်
- `ask` (`off | on-miss | always`): `gateway`/`node` အတွက် အတည်ပြု မေးခွန်းများ
- `node` (string): `host=node` အတွက် နိုဒ် id/အမည်
- `elevated` (bool): မြင့်မားသော မုဒ်ကို တောင်းဆိုခြင်း (Gateway ဟို့စ်); `security=full` သည် မြင့်မားသော အခြေအနေက `full` သို့ ဖြေရှင်းသွားသောအခါသာ အတင်းအကျပ် သတ်မှတ်ပါသည်

မှတ်ချက်များ:

- `host` ၏ မူလတန်ဖိုးမှာ `sandbox` ဖြစ်သည်။
- sandboxing ပိတ်ထားပါက `elevated` ကို လျစ်လျူရှုပါသည် (exec သည် ဟို့စ်ပေါ်တွင် တိုက်ရိုက် လည်ပတ်နေပြီးသား ဖြစ်သည်)။
- `gateway`/`node` အတည်ပြုချက်များကို `~/.openclaw/exec-approvals.json` မှ ထိန်းချုပ်ပါသည်။
- `node` သည် တွဲဖက်ထားသော နိုဒ် (companion app သို့မဟုတ် headless node host) လိုအပ်ပါသည်။
- နိုဒ်များ များစွာ ရှိပါက တစ်ခုရွေးရန် `exec.node` သို့မဟုတ် `tools.exec.node` ကို သတ်မှတ်ပါ။
- Windows မဟုတ်သော ဟို့စ်များတွင် `SHELL` ကို သတ်မှတ်ထားပါက exec သည် ၎င်းကို အသုံးပြုပါသည်; `SHELL` သည် `fish` ဖြစ်ပါက fish နှင့် မကိုက်ညီသော script များကို ရှောင်ရှားရန် `PATH` မှ `bash` (သို့မဟုတ် `sh`) ကို ဦးစားပေးပြီး၊ မရှိပါက `SHELL` သို့ ပြန်လည်ကျသွားပါသည်။
- ဟို့စ်ပေါ် လည်ပတ်မှု (`gateway`/`node`) သည် binary hijacking သို့မဟုတ် ထိုးသွင်းထားသော code များကို တားဆီးရန် `env.PATH` နှင့် loader အစားထိုးမှုများ (`LD_*`/`DYLD_*`) ကို ငြင်းပယ်ပါသည်။
- အရေးကြီးသည်– sandboxing သည် **မူလအနေဖြင့် ပိတ်ထားသည်**။ sandboxing ပိတ်ထားပါက `host=sandbox` သည် gateway host ပေါ်တွင် တိုက်ရိုက် (container မရှိ) လည်ပတ်ပြီး **အတည်ပြုချက် မလိုအပ်ပါ**။ အတည်ပြုချက်များ လိုအပ်စေရန် `host=gateway` ဖြင့် လည်ပတ်ပြီး exec approvals ကို ပြင်ဆင်သတ်မှတ်ပါ (သို့မဟုတ် sandboxing ကို ဖွင့်ပါ)။

## Config

- `tools.exec.notifyOnExit` (မူလ: true): true ဖြစ်ပါက နောက်ခံသို့ ပြောင်းထားသော exec ဆက်ရှင်များသည် စနစ်ဖြစ်ရပ်တစ်ခုကို စာရင်းသွင်းပြီး ထွက်ခွာချိန်တွင် heartbeat တောင်းခံပါသည်။
- `tools.exec.approvalRunningNoticeMs` (မူလ: 10000): အတည်ပြုချက်လိုအပ်သော exec သည် ဤအချိန်ထက် ပိုကြာလျှင် “running” အကြောင်းကြားချက် တစ်ကြိမ်တည်း ထုတ်ပေးပါသည် (0 သည် ပိတ်ထားခြင်း)။
- `tools.exec.host` (မူလ: `sandbox`)
- `tools.exec.security` (မူလ: sandbox အတွက် `deny`, မသတ်မှတ်ထားပါက gateway + node အတွက် `allowlist`)
- `tools.exec.ask` (မူလ: `on-miss`)
- `tools.exec.node` (မူလ: မသတ်မှတ်ထား)
- `tools.exec.pathPrepend`: exec လည်ပတ်မှုများအတွက် `PATH` အရှေ့တွင် ထည့်ပေါင်းမည့် ဒိုင်ရက်ထရီများ စာရင်း။
- `tools.exec.safeBins`: stdin သာ အသုံးပြုသော အန္တရာယ်ကင်း binary များ၊ အထူး allowlist entry မရှိဘဲ လည်ပတ်နိုင်ပါသည်။

ဥပမာ:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH ကို ကိုင်တွယ်ပုံ

- `host=gateway`: သင့် login-shell ၏ `PATH` ကို exec ပတ်ဝန်းကျင်ထဲသို့ ပေါင်းစည်းပါသည်။ ဟို့စ်ပေါ် လည်ပတ်မှုအတွက် `env.PATH` အစားထိုးမှုများကို ငြင်းပယ်ပါသည်။ daemon ကိုယ်တိုင်ကတော့ အနည်းဆုံး `PATH` ဖြင့် လည်ပတ်နေပါသည်:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: container အတွင်း `sh -lc` (login shell) ကို လည်ပတ်စေသဖြင့် `/etc/profile` သည် `PATH` ကို ပြန်လည်သတ်မှတ်နိုင်ပါသည်။ OpenClaw သည် profile source ပြီးနောက် အတွင်းရေး env var တစ်ခုမှတဆင့် `env.PATH` ကို အရှေ့တွင် ထည့်ပေါင်းပါသည် (shell interpolation မရှိပါ)； `tools.exec.pathPrepend` လည်း ဤနေရာတွင် သက်ရောက်ပါသည်။
- `host=node`: သင်ပို့သော ပိတ်မထားသော env အစားထိုးမှုများကိုသာ နိုဒ်သို့ ပို့ပါသည်။ ဟို့စ်ပေါ် လည်ပတ်မှုအတွက် `env.PATH` အစားထိုးမှုများကို ငြင်းပယ်ပါသည်။ headless node host များသည် node host PATH ကို အရှေ့မှ ထည့်ပေါင်းသည့်အခါသာ `PATH` ကို လက်ခံပါသည် (အစားထိုးခြင်း မဟုတ်ပါ)။ macOS နိုဒ်များသည် `PATH` အစားထိုးမှုများကို လုံးဝ ပယ်ဖျက်ပါသည်။

အေးဂျင့်တစ်ခုချင်းစီအလိုက် နိုဒ်ချိတ်ဆက်မှု (config တွင် အေးဂျင့်စာရင်း အညွှန်းကို အသုံးပြုပါ):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Control UI: Nodes tab တွင် တူညီသော သတ်မှတ်ချက်များအတွက် “Exec node binding” ပန်နယ် သေးသေးလေး ပါရှိပါသည်။

## ဆက်ရှင် အစားထိုးမှုများ (`/exec`)

`/exec` ကို အသုံးပြုပြီး `host`, `security`, `ask`, နှင့် `node` အတွက် **ဆက်ရှင်တစ်ခုချင်းစီအလိုက်** မူလတန်ဖိုးများကို သတ်မှတ်ပါ။
လက်ရှိတန်ဖိုးများကို ပြရန် `/exec` ကို အ арг မပါဘဲ ပို့ပါ။

ဥပမာ:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## ခွင့်ပြုချက် မော်ဒယ်

`/exec` သည် **ခွင့်ပြုထားသော ပို့သူများ** (channel allowlists/paired plus `commands.useAccessGroups`) အတွက်သာ လိုက်နာပါသည်။
၎င်းသည် **ဆက်ရှင် အခြေအနေကိုသာ** ပြင်ဆင်ပြီး config သို့ မရေးပါ။ exec ကို အပြီးတိုင် ပိတ်ရန် tool
policy (`tools.deny: ["exec"]` သို့မဟုတ် အေးဂျင့်တစ်ခုချင်းစီအလိုက်) မှတဆင့် ငြင်းပယ်ပါ။
`security=full` နှင့် `ask=off` ကို အထူးသတ်မှတ်မထားလျှင် ဟို့စ် အတည်ပြုချက်များသည် ဆက်လက် သက်ရောက်နေပါသည်။

## Exec approvals (companion app / node host)

sandboxed အေးဂျင့်များသည် `exec` ကို gateway သို့မဟုတ် node host ပေါ်တွင် လည်ပတ်မီ တောင်းဆိုချက်တစ်ခုချင်းစီအတွက် အတည်ပြုချက် လိုအပ်နိုင်ပါသည်။
မူဝါဒ၊ allowlist နှင့် UI လုပ်ငန်းစဉ်များအတွက် [Exec approvals](/tools/exec-approvals) ကို ကြည့်ပါ။

အတည်ပြုချက်များ လိုအပ်သည့်အခါ exec ကိရိယာသည် ချက်ချင်း ပြန်လာပြီး
`status: "approval-pending"` နှင့် အတည်ပြု ID တစ်ခုကို ပေးပါသည်။ အတည်ပြုပြီးပါက (သို့မဟုတ် ငြင်းပယ်/အချိန်ကုန်လွန်ပါက)
Gateway သည် စနစ်ဖြစ်ရပ်များ (`Exec finished` / `Exec denied`) ကို ထုတ်လွှတ်ပါသည်။ အမိန့်သည်
`tools.exec.approvalRunningNoticeMs` ပြီးနောက်တောင် ဆက်လက် လည်ပတ်နေပါက `Exec running` အကြောင်းကြားချက် တစ်ကြိမ်တည်းကို ထုတ်ပေးပါသည်။

## Allowlist + safe bins

Allowlist အကောင်အထည်ဖော်မှုသည် **ဖြေရှင်းပြီးသော binary လမ်းကြောင်းများကိုသာ** ကိုက်ညီစစ်ဆေးပါသည် (basename ဖြင့် မကိုက်ညီပါ)။
`security=allowlist` ဖြစ်ပါက shell အမိန့်များကို pipeline အပိုင်းအစ တစ်ခုချင်းစီအားလုံးသည် allowlist ထဲရှိခြင်း သို့မဟုတ် safe bin ဖြစ်မှသာ အလိုအလျောက် ခွင့်ပြုပါသည်။
Chaining (`;`, `&&`, `||`) နှင့် redirection များကို allowlist မုဒ်တွင် ငြင်းပယ်ပါသည်။

## ဥပမာများ

ရှေ့တန်း (Foreground):

```json
{ "tool": "exec", "command": "ls -la" }
```

နောက်ခံ + စစ်ဆေးခြင်း (poll):

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

ကီးများ ပို့ခြင်း (tmux စတိုင်):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

တင်သွင်းခြင်း (CR သာ ပို့):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste (မူလအားဖြင့် bracketed):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (စမ်းသပ်ဆဲ)

`apply_patch` သည် ဖိုင်များစွာကို ဖွဲ့စည်းပုံတကျ ပြင်ဆင်ရန် `exec` ၏ subtool တစ်ခု ဖြစ်ပါသည်။
သီးသန့် ဖွင့်ပါ:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

မှတ်ချက်များ:

- OpenAI/OpenAI Codex မော်ဒယ်များအတွက်သာ ရရှိနိုင်ပါသည်။
- Tool policy သည် ဆက်လက် သက်ရောက်နေပြီး `allow: ["exec"]` သည် `apply_patch` ကို အလိုအလျောက် ခွင့်ပြုပါသည်။
- Config သည် `tools.exec.applyPatch` အောက်တွင် ရှိပါသည်။
