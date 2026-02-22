---
summary: "Exec ကိရိယာ၏ အသုံးပြုပုံ၊ stdin မုဒ်များနှင့် TTY ပံ့ပိုးမှု"
read_when:
  - exec ကိရိယာကို အသုံးပြုခြင်း သို့မဟုတ် ပြုပြင်ပြောင်းလဲခြင်း
  - stdin သို့မဟုတ် TTY အပြုအမူများကို အမှားရှာဖွေခြင်း
title: "Exec ကိရိယာ"
---

# Exec ကိရိယာ

workspace အတွင်း shell commands များကို လည်ပတ်စေပါ။ `process` ကို အသုံးပြုပြီး foreground + background execution ကို ထောက်ပံ့သည်။
`process` ကို ခွင့်မပြုထားပါက `exec` သည် synchronous အဖြစ် လည်ပတ်ပြီး `yieldMs`/`background` ကို လျစ်လျူရှုပါသည်။
Background sessions များကို agent အလိုက် scope ချထားပြီး `process` သည် agent တစ်ခုတည်းမှ sessions များကိုသာ မြင်နိုင်သည်။

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
- အရေးကြီးသည်– sandboxing သည် **default အနေဖြင့် ပိတ်ထားသည်**။ Sandboxing ပိတ်ထားပါက `host=sandbox` သည် gateway host ပေါ်တွင် တိုက်ရိုက် run လုပ်ပြီး (container မရှိ) **approvals မလိုအပ်ပါ**။ Approvals လိုအပ်စေရန် `host=gateway` ဖြင့် run လုပ်ပြီး exec approvals ကို configure လုပ်ပါ (သို့မဟုတ် sandboxing ကို ဖွင့်ပါ)။

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

- `host=gateway` သည် သင့် login-shell ၏ `PATH` ကို exec environment ထဲသို့ ပေါင်းထည့်ပေးသည်။ Host execution အတွက် `env.PATH` override များကို လက်မခံပါ။ Daemon ကိုယ်တိုင်သည် minimal `PATH` ဖြင့် ဆက်လက် run လုပ်နေဆဲဖြစ်သည်။
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox` သည် container အတွင်း `sh -lc` (login shell) ကို run လုပ်သောကြောင့် `/etc/profile` က `PATH` ကို ပြန်လည်သတ်မှတ်နိုင်သည်။
  OpenClaw သည် profile sourcing ပြီးနောက် internal env var မှတဆင့် `env.PATH` ကို prepend လုပ်သည် (shell interpolation မရှိ)၊ `tools.exec.pathPrepend` သည်လည်း ဤနေရာတွင် သက်ဆိုင်သည်။
- `host=node` သည် သင်ပို့လိုက်သော non-blocked env override များကိုသာ node သို့ ပို့သည်။ Host execution အတွက် `env.PATH` override များကို လက်မခံပါ။ Headless node hosts များသည် node host ၏ PATH ကို prepend လုပ်သောအခါတွင်သာ `PATH` ကို လက်ခံသည် (အစားထိုးခြင်း မပြုလုပ်ပါ)။ macOS nodes များသည် `PATH` override များကို လုံးဝ ဖယ်ရှားပစ်သည်။

အေးဂျင့်တစ်ခုချင်းစီအလိုက် နိုဒ်ချိတ်ဆက်မှု (config တွင် အေးဂျင့်စာရင်း အညွှန်းကို အသုံးပြုပါ):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Control UI: Nodes tab တွင် တူညီသော သတ်မှတ်ချက်များအတွက် “Exec node binding” ပန်နယ် သေးသေးလေး ပါရှိပါသည်။

## ဆက်ရှင် အစားထိုးမှုများ (`/exec`)

`/exec` ကို အသုံးပြုပြီး `host`, `security`, `ask`, နှင့် `node` အတွက် **per-session** default များကို သတ်မှတ်နိုင်သည်။
Argument မပါဘဲ `/exec` ကို ပို့ပါက လက်ရှိ value များကို ပြသသည်။

ဥပမာ:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## ခွင့်ပြုချက် မော်ဒယ်

`/exec` သည် **authorized senders** များအတွက်သာ အလုပ်လုပ်သည် (channel allowlists/pairing နှင့် `commands.useAccessGroups`)။
ဤအရာသည် **session state ကိုသာ** update လုပ်ပြီး config ကို မရေးပါ။ Exec ကို အပြည့်အဝ ပိတ်ရန် tool policy မှတဆင့် deny လုပ်ပါ (`tools.deny: ["exec"]` သို့မဟုတ် per-agent)။ `security=full` နှင့် `ask=off` ကို ထင်ရှားစွာ သတ်မှတ်ထားခြင်း မရှိပါက host approvals များသည် ဆက်လက် သက်ဆိုင်နေသည်။

## Exec approvals (companion app / node host)

Sandboxed agents များသည် `exec` ကို gateway သို့မဟုတ် node host ပေါ်တွင် run မလုပ်မီ request တစ်ခုချင်းစီအတွက် approval လိုအပ်စေနိုင်သည်။
Policy၊ allowlist နှင့် UI flow အတွက် [Exec approvals](/tools/exec-approvals) ကို ကြည့်ပါ။

Approvals လိုအပ်ပါက exec tool သည် ချက်ချင်း ပြန်လည်ဖြေကြားပြီး `status: "approval-pending"` နှင့် approval id ကို ပြန်ပေးသည်။ Approved (သို့မဟုတ် denied / timed out) ဖြစ်သည့်အခါ Gateway သည် system events (`Exec finished` / `Exec denied`) ကို ထုတ်လွှတ်သည်။ Command သည် `tools.exec.approvalRunningNoticeMs` ကျော်လွန်၍ ဆက်လက် run နေပါက `Exec running` notice တစ်ကြိမ်သာ ထုတ်လွှတ်သည်။

## Allowlist + safe bins

Allowlist enforcement သည် **resolved binary paths** များနှင့်သာ ကိုက်ညီစစ်ဆေးသည် (basename ကို မကိုက်ညီစစ်ဆေးပါ)။ `security=allowlist` ဖြစ်သောအခါ shell commands များကို pipeline segment တိုင်းသည် allowlist ထဲတွင်ရှိခြင်း သို့မဟုတ် safe bin ဖြစ်ခြင်း အခြေအနေတွင်သာ auto-allow လုပ်သည်။ Allowlist mode တွင် chaining (`;`, `&&`, `||`) နှင့် redirections များကို လက်မခံပါ။

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

`apply_patch` သည် structured multi-file edits အတွက် `exec` ၏ subtool တစ်ခုဖြစ်သည်။
၎င်းကို ထင်ရှားစွာ ဖွင့်ပါ:

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
