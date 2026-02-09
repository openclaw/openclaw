---
title: Sandbox vs Tool Policy vs Elevated
summary: "Tool တစ်ခု ဘာကြောင့် ပိတ်ထားရသလဲဆိုတာ—sandbox runtime၊ tool allow/deny policy နဲ့ elevated exec gate တွေ"
read_when: "'sandbox jail' ကို ရောက်သွားတာမျိုး သို့မဟုတ် tool/elevated ပယ်ချခြင်းကို တွေ့ပြီး ဘယ် config key ကို ပြောင်းရမလဲ အတိအကျ သိချင်တဲ့အခါ"
status: active
---

# Sandbox vs Tool Policy vs Elevated

OpenClaw မှာ ဆက်စပ်ပေမယ့် မတူညီတဲ့ ထိန်းချုပ်မှု သုံးခု ရှိပါတယ်—

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) က **tool တွေ ဘယ်နေရာမှာ chạy မလဲ** (Docker vs host) ကို ဆုံးဖြတ်ပါတယ်။
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) က **ဘယ် tool တွေ ရနိုင်/ခေါ်နိုင်မလဲ** ကို ဆုံးဖြတ်ပါတယ်။
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) က sandbox ထဲရှိနေချိန် **host ပေါ်မှာ chạy ဖို့ exec-only ထွက်ပေါက်** တစ်ခု ဖြစ်ပါတယ်။

## Quick debug

OpenClaw က အမှန်တကယ် ဘာလုပ်နေလဲ ဆိုတာကို ကြည့်ဖို့ inspector ကို အသုံးပြုပါ—

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

ဒါက အောက်ပါအချက်တွေကို ပြသပါတယ်—

- အကျိုးသက်ရောက်နေတဲ့ sandbox mode/scope/workspace access
- လက်ရှိ session က sandboxed ဖြစ်နေလား (main vs non-main)
- အကျိုးသက်ရောက်နေတဲ့ sandbox tool allow/deny (agent/global/default မှ ဘယ်ဟာက လာလဲ ဆိုတာပါ)
- elevated gate တွေ နဲ့ fix-it key path များ

## Sandbox: tool တွေ chạy မယ့် နေရာ

Sandboxing ကို `agents.defaults.sandbox.mode` နဲ့ ထိန်းချုပ်ပါတယ်—

- `"off"`: အရာအားလုံးကို host ပေါ်မှာ chạy ပါတယ်။
- `"non-main"`: non-main session တွေကိုပဲ sandbox လုပ်ပါတယ် (group/channel တွေမှာ မကြာခဏ “အံ့ဩစရာ” ဖြစ်တတ်).
- `"all"`: အရာအားလုံးကို sandbox လုပ်ပါတယ်။

အပြည့်အစုံ (scope, workspace mounts, images) ကို [Sandboxing](/gateway/sandboxing) မှာ ကြည့်ပါ။

### Bind mounts (လုံခြုံရေး အမြန်စစ်ဆေးချက်)

- `docker.binds` က sandbox filesystem ကို _ဖောက်ထွင်း_ သွားစေပါတယ်—သင် mount လုပ်ထားတဲ့အရာအားလုံးကို container အတွင်းမှာ သတ်မှတ်ထားတဲ့ mode (`:ro` သို့မဟုတ် `:rw`) နဲ့ မြင်ရပါတယ်။
- Mode ကို မရေးမိရင် default က read-write ဖြစ်ပါတယ်; source/secrets အတွက် `:ro` ကို ဦးစားပေးပါ။
- `scope: "shared"` က per-agent bind တွေကို လျစ်လျူရှုပါတယ် (global bind တွေပဲ အသုံးချပါတယ်)။
- `/var/run/docker.sock` ကို bind လုပ်ခြင်းက sandbox ကို host ထိန်းချုပ်ခွင့် ပေးသလို ဖြစ်သွားပါတယ်—ရည်ရွယ်ချက်ရှိမှသာ လုပ်ပါ။
- Workspace access (`workspaceAccess: "ro"`/`"rw"`) က bind mode တွေနဲ့ သီးခြား ဖြစ်ပါတယ်။

## Tool policy: ဘယ် tool တွေ ရှိ/ခေါ်နိုင်လဲ

အရေးကြီးတဲ့ အလွှာ နှစ်ခု—

- **Tool profile**: `tools.profile` နှင့် `agents.list[].tools.profile` (base allowlist)
- **Provider tool profile**: `tools.byProvider[provider].profile` နှင့် `agents.list[].tools.byProvider[provider].profile`
- **Global/per-agent tool policy**: `tools.allow`/`tools.deny` နှင့် `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider tool policy**: `tools.byProvider[provider].allow/deny` နှင့် `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox tool policy** (sandboxed ဖြစ်နေချိန်မှာပဲ သက်ရောက်): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` နှင့် `agents.list[].tools.sandbox.tools.*`

အထွေထွေ မှတ်သားစရာများ—

- `deny` က အမြဲတမ်း အနိုင်ရပါတယ်။
- `allow` က မလွတ်မလပ် မဟုတ်ရင် အခြားအရာအားလုံးကို ပိတ်ထားသလို ဆက်ဆံပါတယ်။
- Tool policy က အဆုံးသတ် အတားအဆီးပါ—`/exec` က ပိတ်ထားတဲ့ `exec` tool ကို override မလုပ်နိုင်ပါ။
- `/exec` only changes session defaults for authorized senders; it does not grant tool access.
  Provider tool keys accept either `provider` (e.g. `google-antigravity`) or `provider/model` (e.g. `openai/gpt-5.2`).

### Tool groups (shorthand များ)

Tool policy (global, agent, sandbox) တွေမှာ tool အများအပြားကို ချဲ့ထွင်ပေးတဲ့ `group:*` entry တွေကို ထောက်ပံ့ပါတယ်—

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

ရရှိနိုင်တဲ့ group များ—

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: OpenClaw built-in tool အားလုံး (provider plugin မပါ)

## Elevated: exec-only “host ပေါ်မှာ chạy”

Elevated က **tool အသစ်တွေ မပေးပါ**; `exec` ကိုပဲ သက်ရောက်စေပါတယ်။

- Sandbox ထဲရှိနေချိန် `/elevated on` (သို့မဟုတ် `exec` ကို `elevated: true` နဲ့) က host ပေါ်မှာ chạy ပါတယ် (approval လိုနိုင်သေးပါတယ်)။
- Session အတွက် exec approval ကို ကျော်ချင်ရင် `/elevated full` ကို သုံးပါ။
- Direct mode နဲ့ chạy နေပြီးသားဆိုရင် elevated က အကျိုးသက်ရောက်မှု မရှိသလို ဖြစ်ပါတယ် (ဒါပေမယ့် gate က ဆက်ရှိပါတယ်)။
- Elevated က **skill-scoped မဟုတ်ပါ**၊ tool allow/deny ကိုလည်း **override မလုပ်ပါ**။
- `/exec` is separate from elevated. It only adjusts per-session exec defaults for authorized senders.

Gate များ—

- Enablement: `tools.elevated.enabled` (လိုအပ်ရင် `agents.list[].tools.elevated.enabled`)
- Sender allowlists: `tools.elevated.allowFrom.<provider>` (and optionally `agents.list[].tools.elevated.allowFrom.<provider>`)

အသေးစိတ်ကို [Elevated Mode](/tools/elevated) မှာ ကြည့်ပါ။

## ပုံမှန် “sandbox jail” ဖြေရှင်းနည်းများ

### “Tool X ကို sandbox tool policy က ပိတ်ထားတယ်”

ပြင်ဆင်ရန် key များ (တစ်ခုရွေးပါ)—

- Sandbox ကို ပိတ်ပါ: `agents.defaults.sandbox.mode=off` (သို့မဟုတ် per-agent `agents.list[].sandbox.mode=off`)
- Sandbox အတွင်းမှာ tool ကို ခွင့်ပြုပါ—
  - `tools.sandbox.tools.deny` မှ ဖယ်ရှားပါ (သို့မဟုတ် per-agent `agents.list[].tools.sandbox.tools.deny`)
  - သို့မဟုတ် `tools.sandbox.tools.allow` ထဲ ထည့်ပါ (သို့မဟုတ် per-agent allow)

### “ဒါ main လို့ ထင်ထားတာ၊ ဘာလို့ sandboxed ဖြစ်နေလဲ?”

In `"non-main"` mode, group/channel keys are _not_ main. Use the main session key (shown by `sandbox explain`) or switch mode to `"off"`.
