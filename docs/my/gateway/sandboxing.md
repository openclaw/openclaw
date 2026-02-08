---
summary: "OpenClaw sandboxing အလုပ်လုပ်ပုံ—မုဒ်များ၊ အကျယ်အဝန်းများ၊ workspace ဝင်ရောက်ခွင့်နှင့် image များ"
title: Sandboxing
read_when: "Sandboxing ကို သီးသန့်ရှင်းလင်းချက်လိုအပ်သည့်အခါ သို့မဟုတ် agents.defaults.sandbox ကို ချိန်ညှိရန် လိုအပ်သည့်အခါ"
status: active
x-i18n:
  source_path: gateway/sandboxing.md
  source_hash: c1bb7fd4ac37ef73
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:42Z
---

# Sandboxing

OpenClaw သည် **tools များကို Docker container များအတွင်း 실행** လုပ်နိုင်ပြီး blast radius ကို လျှော့ချရန် အတွက် အသုံးပြုနိုင်သည်။
ဤအရာသည် **optional** ဖြစ်ပြီး configuration (`agents.defaults.sandbox` သို့မဟုတ်
`agents.list[].sandbox`) ဖြင့် ထိန်းချုပ်ထားသည်။ sandboxing ကို ပိတ်ထားပါက tools များသည် host ပေါ်တွင် 실행 လုပ်မည်ဖြစ်သည်။
Gateway သည် host ပေါ်တွင် ဆက်လက်တည်ရှိနေပြီး sandboxing ကို ဖွင့်ထားပါက
tool execution များကို သီးခြားထားသော sandbox အတွင်းတွင် 실행 လုပ်မည်ဖြစ်သည်။

ဤအရာသည် ပြည့်စုံသော လုံခြုံရေးအကန့်အသတ် မဟုတ်သော်လည်း model က အမှားလုပ်ဆောင်သည့်အခါ
filesystem နှင့် process ဝင်ရောက်ခွင့်ကို အရေးပါစွာ ကန့်သတ်ပေးနိုင်သည်။

## What gets sandboxed

- Tool execution (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, စသည်တို့)။
- Optional sandboxed browser (`agents.defaults.sandbox.browser`)။
  - ပုံမှန်အားဖြင့် sandbox browser သည် browser tool လိုအပ်သည့်အချိန်တွင်
    auto-start လုပ်ပြီး (CDP ကို ချိတ်ဆက်နိုင်ကြောင်း သေချာစေသည်)။
    `agents.defaults.sandbox.browser.autoStart` နှင့် `agents.defaults.sandbox.browser.autoStartTimeoutMs` ဖြင့် ပြင်ဆင်သတ်မှတ်နိုင်သည်။
  - `agents.defaults.sandbox.browser.allowHostControl` သည် sandboxed session များကို host browser သို့ တိတိကျကျ ညွှန်ပြနိုင်စေသည်။
  - Optional allowlists များသည် `target: "custom"` ကို gate လုပ်ပေးသည် —
    `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`။

Sandbox မလုပ်သည့်အရာများ—

- Gateway process ကိုယ်တိုင်။
- Host ပေါ်တွင် 실행 လုပ်ရန် အထူးခွင့်ပြုထားသော tool များ (ဥပမာ `tools.elevated`)။
  - **Elevated exec သည် host ပေါ်တွင် 실행 လုပ်ပြီး sandboxing ကို ကျော်လွန်သည်။**
  - Sandboxing ကို ပိတ်ထားပါက `tools.elevated` သည် execution ကို မပြောင်းလဲပါ (ပြီးသား host ပေါ်တွင်ဖြစ်နေသည်)။
    [Elevated Mode](/tools/elevated) ကို ကြည့်ပါ။

## Modes

`agents.defaults.sandbox.mode` သည် sandboxing ကို **ဘယ်အချိန်မှာ** အသုံးပြုမည်ကို ထိန်းချုပ်သည်—

- `"off"`: sandboxing မလုပ်ပါ။
- `"non-main"`: **non-main** sessions များအတွက်သာ sandbox (host ပေါ်တွင် ပုံမှန် chat များကို လိုလားပါက default)။
- `"all"`: session အားလုံးကို sandbox အတွင်းတွင် 실행 လုပ်သည်။
  မှတ်ချက် — `"non-main"` သည် agent id မဟုတ်ဘဲ `session.mainKey` (default `"main"`) ကို အခြေခံထားသည်။
  Group/channel session များသည် ကိုယ်ပိုင် key များကို အသုံးပြုသဖြင့် non-main အဖြစ်တွက်ပြီး sandbox လုပ်မည်ဖြစ်သည်။

## Scope

`agents.defaults.sandbox.scope` သည် **container အရေအတွက်** ကို ထိန်းချုပ်သည်—

- `"session"` (default): session တစ်ခုလျှင် container တစ်ခု။
- `"agent"`: agent တစ်ခုလျှင် container တစ်ခု။
- `"shared"`: sandboxed session အားလုံးအတွက် container တစ်ခုကို မျှဝေသုံးစွဲသည်။

## Workspace access

`agents.defaults.sandbox.workspaceAccess` သည် **sandbox မှ မြင်နိုင်သောအရာများ** ကို ထိန်းချုပ်သည်—

- `"none"` (default): tools များသည် `~/.openclaw/sandboxes` အောက်ရှိ sandbox workspace ကို မြင်နိုင်သည်။
- `"ro"`: agent workspace ကို `/agent` တွင် read-only အဖြစ် mount လုပ်သည်
  (`write`/`edit`/`apply_patch` ကို ပိတ်ထားသည်)။
- `"rw"`: agent workspace ကို `/workspace` တွင် read/write အဖြစ် mount လုပ်သည်။

Inbound media များကို active sandbox workspace (`media/inbound/*`) သို့ copy လုပ်သည်။
Skills မှတ်ချက် — `read` tool သည် sandbox-rooted ဖြစ်သည်။
`workspaceAccess: "none"` ဖြင့် OpenClaw သည် သင့်လျော်သော skills များကို sandbox workspace (`.../skills`) သို့ mirror လုပ်ပြီး
ဖတ်ရှုနိုင်စေသည်။ `"rw"` ဖြင့် workspace skills များကို
`/workspace/skills` မှ ဖတ်ရှုနိုင်သည်။

## Custom bind mounts

`agents.defaults.sandbox.docker.binds` သည် host directory များကို container အတွင်းသို့ ထပ်မံ mount လုပ်ပေးသည်။
Format: `host:container:mode` (ဥပမာ `"/home/user/source:/source:rw"`)။

Global နှင့် per-agent bind များကို **ပေါင်းစည်း** လုပ်သည် (အစားထိုးမလုပ်ပါ)။
`scope: "shared"` အောက်တွင် per-agent bind များကို လျစ်လျူရှုမည်ဖြစ်သည်။

ဥပမာ (read-only source + docker socket)—

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Security မှတ်ချက်များ—

- Bind များသည် sandbox filesystem ကို ကျော်လွန်ပြီး သင်သတ်မှတ်ထားသော mode (`:ro` သို့မဟုတ် `:rw`) ဖြင့် host path များကို ဖော်ထုတ်ပေးသည်။
- အရေးကြီးသော mount များ (ဥပမာ `docker.sock`, secrets, SSH keys) ကို မဖြစ်မနေ မလိုအပ်ပါက `:ro` အဖြစ် သတ်မှတ်သင့်သည်။
- Workspace ကို read access သာ လိုအပ်ပါက `workspaceAccess: "ro"` နှင့် ပေါင်းစပ်အသုံးပြုပါ; bind mode များသည် သီးခြားအဖြစ် ဆက်လက်သက်ရောက်သည်။
- Bind များသည် tool policy နှင့် elevated exec တို့နှင့် မည်သို့ အပြန်အလှန် သက်ရောက်သည်ကို
  [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) တွင် ကြည့်ပါ။

## Images + setup

Default image: `openclaw-sandbox:bookworm-slim`

တစ်ကြိမ်သာ build လုပ်ပါ—

```bash
scripts/sandbox-setup.sh
```

မှတ်ချက် — default image တွင် Node မပါဝင်ပါ။
Skill တစ်ခုက Node (သို့မဟုတ် အခြား runtime များ) လိုအပ်ပါက
custom image တစ်ခုကို bake လုပ်ပါ သို့မဟုတ်
`sandbox.docker.setupCommand` ဖြင့် install လုပ်ပါ
(network egress + writable root +
root user လိုအပ်သည်)။

Sandboxed browser image—

```bash
scripts/sandbox-browser-setup.sh
```

ပုံမှန်အားဖြင့် sandbox container များသည် **network မရှိပါ**။
`agents.defaults.sandbox.docker.network` ဖြင့် override လုပ်နိုင်သည်။

Docker install များနှင့် containerized gateway တည်ရှိရာ—
[Docker](/install/docker)

## setupCommand (one-time container setup)

`setupCommand` သည် sandbox container ကို ဖန်တီးပြီးနောက် **တစ်ကြိမ်သာ** 실행 လုပ်သည်
(run တစ်ကြိမ်စီတိုင်း မဟုတ်ပါ)။
`sh -lc` ဖြင့် container အတွင်းမှ 실행 လုပ်သည်။

Paths—

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

Common pitfalls—

- Default `docker.network` သည် `"none"` (egress မရှိ) ဖြစ်သောကြောင့် package install များ မအောင်မြင်နိုင်ပါ။
- `readOnlyRoot: true` သည် write ကို တားဆီးသည်; `readOnlyRoot: false` သတ်မှတ်ပါ သို့မဟုတ် custom image တစ်ခု bake လုပ်ပါ။
- Package install များအတွက် `user` သည် root ဖြစ်ရမည်
  (`user` ကို ဖယ်ရှားပါ သို့မဟုတ် `user: "0:0"` ကို သတ်မှတ်ပါ)။
- Sandbox exec သည် host ၏ `process.env` ကို မယူဆောင်ပါ။
  Skill API key များအတွက် `agents.defaults.sandbox.docker.env` (သို့မဟုတ် custom image) ကို အသုံးပြုပါ။

## Tool policy + escape hatches

Tool allow/deny policy များသည် sandbox rule မတိုင်မီ ဆက်လက် သက်ရောက်နေပါသည်။
Tool တစ်ခုကို global သို့မဟုတ် per-agent အလိုက် deny လုပ်ထားပါက
sandboxing က ပြန်လည် အသုံးပြုခွင့် မပေးနိုင်ပါ။

`tools.elevated` သည် host ပေါ်တွင် `exec` ကို 실행 လုပ်ပေးသော explicit escape hatch ဖြစ်သည်။
`/exec` directive များသည် authorized senders များအတွက်သာ သက်ရောက်ပြီး
session တစ်ခုချင်းစီအလိုက် ဆက်လက်တည်ရှိသည်;
`exec` ကို အမြဲတမ်း ပိတ်ထားလိုပါက
tool policy deny ကို အသုံးပြုပါ
([Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) ကို ကြည့်ပါ)။

Debugging—

- Effective sandbox mode, tool policy နှင့် fix-it config key များကို စစ်ဆေးရန် `openclaw sandbox explain` ကို အသုံးပြုပါ။
- “ဘာကြောင့် ဒါကို ပိတ်ထားတာလဲ?” ဆိုသည့် mental model အတွက်
  [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) ကို ကြည့်ပါ။
  Lock down ထားထားပါ။

## Multi-agent overrides

Agent တစ်ခုချင်းစီအလိုက် sandbox နှင့် tools ကို override လုပ်နိုင်သည်—
`agents.list[].sandbox` နှင့် `agents.list[].tools`
( sandbox tool policy အတွက် `agents.list[].tools.sandbox.tools` အပါအဝင်)။
Precedence အတွက်
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) ကို ကြည့်ပါ။

## Minimal enable example

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Related docs

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
