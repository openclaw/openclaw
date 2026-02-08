---
title: Lobster
summary: "OpenClaw အတွက် ပြန်လည်စတင်နိုင်သော အတည်ပြုချက်ဂိတ်များ ပါဝင်သည့် Typed workflow runtime"
description: OpenClaw အတွက် Typed workflow runtime — အတည်ပြုချက်ဂိတ်များပါဝင်သော ပေါင်းစည်းနိုင်သည့် ပိုက်လိုင်းများ။
read_when:
  - သတ်မှတ်ချက်ပြည့်မီပြီး အဆင့်လိုက်လုပ်ဆောင်ရသော workflow များကို ထင်ရှားသော အတည်ပြုချက်များနှင့်အတူ လိုအပ်ပါက
  - အစောပိုင်းအဆင့်များကို ပြန်မလုပ်ဘဲ workflow ကို ပြန်လည်စတင်လိုပါက
x-i18n:
  source_path: tools/lobster.md
  source_hash: e787b65558569e8a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:35Z
---

# Lobster

Lobster သည် OpenClaw ကို အဆင့်များစွာပါဝင်သော tool အစီအစဉ်များကို တစ်ခုတည်းသော၊ သတ်မှတ်ချက်ပြည့်မီသည့် လုပ်ဆောင်မှုအဖြစ် လည်ပတ်စေနိုင်ပြီး ထင်ရှားသော အတည်ပြုချက် checkpoint များပါဝင်စေသည့် workflow shell ဖြစ်သည်။

## Hook

သင့် assistant ကိုယ်တိုင်ကို စီမံခန့်ခွဲနိုင်သော tools များကို တည်ဆောက်နိုင်ပါသည်။ workflow တစ်ခုကို တောင်းဆိုပါ—မိနစ် ၃၀ အကြာတွင် CLI တစ်ခုနှင့် တစ်ခေါက်ခေါ်လိုက်ရုံဖြင့် လည်ပတ်နိုင်သော pipelines များကို ရရှိပါလိမ့်မည်။ Lobster သည် ပျောက်ကွယ်နေသော အစိတ်အပိုင်းဖြစ်ပြီး—သတ်မှတ်ချက်ပြည့်မီသော pipelines၊ ထင်ရှားသော အတည်ပြုချက်များ၊ နှင့် ပြန်လည်စတင်နိုင်သော state များကို ပံ့ပိုးပေးသည်။

## Why

ယနေ့တွင် ရှုပ်ထွေးသော workflow များသည် tool ခေါ်ဆိုမှုများကို အကြိမ်ကြိမ် ပြန်လည်လုပ်ဆောင်ရတတ်သည်။ ခေါ်ဆိုမှုတိုင်းသည် token ကုန်ကျစရိတ်ရှိပြီး LLM သည် အဆင့်တိုင်းကို ကိုယ်တိုင် စီမံညှိနှိုင်းရပါသည်။ Lobster သည် ထိုညှိနှိုင်းမှုကို typed runtime အတွင်းသို့ ရွှေ့ပြောင်းပေးသည်။

- **တစ်ခေါက်ခေါ်ဆိုခြင်းသာ**: OpenClaw သည် Lobster tool ကို တစ်ခါတည်း ခေါ်ပြီး ဖွဲ့စည်းထားသော ရလဒ်ကို ရယူသည်။
- **အတည်ပြုချက်များ ပါဝင်ပြီးသား**: အကျိုးသက်ရောက်မှုရှိသော လုပ်ဆောင်ချက်များ (အီးမေးလ်ပို့ခြင်း၊ မှတ်ချက်တင်ခြင်း) သည် ထင်ရှားစွာ အတည်ပြုမချင်း workflow ကို ရပ်တန့်ထားသည်။
- **ပြန်လည်စတင်နိုင်မှု**: ရပ်တန့်ထားသော workflow များသည် token တစ်ခုကို ပြန်ပေးပြီး အတည်ပြုပြီးနောက် အရာအားလုံးကို ပြန်မလုပ်ဘဲ ဆက်လက်လုပ်ဆောင်နိုင်သည်။

## Why a DSL instead of plain programs?

Lobster ကို ရည်ရွယ်ချက်ရှိရှိ သေးငယ်အောင် ဒီဇိုင်းလုပ်ထားသည်။ ရည်ရွယ်ချက်မှာ “ဘာသာစကားအသစ်တစ်ခု” မဟုတ်ဘဲ AI နှင့်လိုက်ဖက်ပြီး ခန့်မှန်းနိုင်သော pipeline specification တစ်ခုကို ဖန်တီးခြင်းဖြစ်ပြီး အတည်ပြုချက်များနှင့် resume token များကို ပထမတန်းစားအဖြစ် ထည့်သွင်းထားသည်။

- **Approve/resume ကို မူလက ပါဝင်**: ပုံမှန် program တစ်ခုသည် လူကို မေးနိုင်သော်လည်း ကိုယ်တိုင် runtime မတီထွင်ဘဲ အကြမ်းခံ token ဖြင့် _ရပ်ပြီး ပြန်လည်စတင်_ မလုပ်နိုင်ပါ။
- **Determinism + auditability**: Pipelines များသည် data ဖြစ်သောကြောင့် log ပြုလုပ်ရန်၊ diff ကြည့်ရန်၊ ပြန်ကစားရန်၊ စစ်ဆေးရန် လွယ်ကူသည်။
- **AI အတွက် ကန့်သတ်ထားသော မျက်နှာပြင်**: grammar သေးငယ်ခြင်း + JSON piping သည် “ဖန်တီးမှုလမ်းကြောင်းများ” ကို လျှော့ချပြီး စစ်ဆေးခြင်းကို လက်တွေ့ကျစေသည်။
- **လုံခြုံရေးမူဝါဒကို မူလက ထည့်သွင်းထားခြင်း**: timeout များ၊ output ကန့်သတ်ချက်များ၊ sandbox စစ်ဆေးမှုများ၊ allowlist များကို script တစ်ခုချင်းစီမဟုတ်ဘဲ runtime က အတည်ပြုအကောင်အထည်ဖော်သည်။
- **ပရိုဂရမ်ရေးနိုင်ဆဲ**: အဆင့်တိုင်းသည် မည်သည့် CLI သို့မဟုတ် script မဆို ခေါ်နိုင်သည်။ JS/TS လိုပါက code မှ `.lobster` ဖိုင်များကို ထုတ်လုပ်နိုင်သည်။

## How it works

OpenClaw သည် local `lobster` CLI ကို **tool mode** ဖြင့် လည်ပတ်စေပြီး stdout မှ JSON envelope တစ်ခုကို ဖတ်ရှုသည်။
pipeline သည် အတည်ပြုချက်အတွက် ရပ်တန့်ပါက နောက်တစ်ကြိမ် ဆက်လက်လုပ်ဆောင်နိုင်ရန် `resumeToken` ကို ပြန်ပေးသည်။

## Pattern: small CLI + JSON pipes + approvals

JSON ကို ပြောနိုင်သော command သေးငယ်များကို တည်ဆောက်ပြီး တစ်ခုတည်းသော Lobster call အဖြစ် ချိတ်ဆက်ပါ။ (အောက်ပါ ဥပမာ command အမည်များကို သင့်အမည်များဖြင့် အစားထိုးနိုင်ပါသည်။)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

pipeline သည် အတည်ပြုချက်ကို တောင်းဆိုပါက token ဖြင့် ပြန်လည်စတင်ပါ။

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI သည် workflow ကို လှုံ့ဆော်ပြီး Lobster သည် အဆင့်များကို အကောင်အထည်ဖော်သည်။ အတည်ပြုချက်ဂိတ်များသည် အကျိုးသက်ရောက်မှုများကို ထင်ရှားစွာ မှတ်တမ်းတင်နိုင်စေသည်။

ဥပမာ- input item များကို tool call များအဖြစ် map လုပ်ခြင်း။

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

**ဖွဲ့စည်းထားသော LLM အဆင့်** လိုအပ်သော workflow များအတွက် optional
`llm-task` plugin tool ကို ဖွင့်ပြီး Lobster မှ ခေါ်ဆိုနိုင်သည်။ ဤနည်းဖြင့် workflow ကို သတ်မှတ်ချက်ပြည့်မီအောင် ထိန်းထားနိုင်ပြီး model ဖြင့် ခွဲခြားခြင်း/အကျဉ်းချုပ်ခြင်း/ရေးဆွဲခြင်းများကို လုပ်ဆောင်နိုင်သည်။

tool ကို ဖွင့်ရန်-

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

pipeline တွင် အသုံးပြုရန်-

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

အသေးစိတ်နှင့် configuration ရွေးချယ်စရာများအတွက် [LLM Task](/tools/llm-task) ကို ကြည့်ပါ။

## Workflow files (.lobster)

Lobster သည် `name`, `args`, `steps`, `env`, `condition`, နှင့် `approval` field များပါဝင်သော YAML/JSON workflow ဖိုင်များကို လည်ပတ်စေနိုင်သည်။ OpenClaw tool call များတွင် ဖိုင်လမ်းကြောင်းအဖြစ် `pipeline` ကို သတ်မှတ်ပါ။

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

မှတ်ချက်များ-

- `stdin: $step.stdout` နှင့် `stdin: $step.json` သည် အရင်အဆင့်၏ output ကို ပို့ပေးသည်။
- `condition` (သို့မဟုတ် `when`) သည် `$step.approved` အပေါ် မူတည်၍ အဆင့်များကို gate လုပ်နိုင်သည်။

## Install Lobster

OpenClaw Gateway ကို လည်ပတ်သည့် **တူညီသော ဟို့စ်** ပေါ်တွင် Lobster CLI ကို ထည့်သွင်းပါ ([Lobster repo](https://github.com/openclaw/lobster) ကို ကြည့်ပါ) နှင့် `lobster` သည် `PATH` တွင် ရှိကြောင်း သေချာပါစေ။
custom binary location ကို အသုံးပြုလိုပါက tool call တွင် **absolute** `lobsterPath` ကို ပေးပို့ပါ။

## Enable the tool

Lobster သည် **optional** plugin tool ဖြစ်ပြီး မူလအတိုင်း မဖွင့်ထားပါ။

အကြံပြုထားသော နည်းလမ်း (additive, safe) -

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

သို့မဟုတ် per-agent -

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

restrictive allowlist mode ဖြင့် လည်ပတ်ရန် ရည်ရွယ်ထားခြင်း မရှိပါက `tools.allow: ["lobster"]` ကို မသုံးရန် ရှောင်ပါ။

မှတ်ချက်- optional plugin များအတွက် allowlist များသည် opt-in ဖြစ်သည်။ သင့် allowlist တွင်
`lobster` ကဲ့သို့ plugin tool များသာ ပါဝင်ပါက OpenClaw သည် core tool များကို ဆက်လက် ဖွင့်ထားပါသည်။ core tool များကို ကန့်သတ်လိုပါက allowlist ထဲတွင် လိုချင်သော core tool သို့မဟုတ် group များကိုပါ ထည့်သွင်းပါ။

## Example: Email triage

Lobster မပါဘဲ-

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Lobster နှင့်အတူ-

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

JSON envelope ကို ပြန်ပေးသည် (အတိုချုံး)-

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

User အတည်ပြု → ပြန်လည်စတင်-

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

workflow တစ်ခုတည်း။ သတ်မှတ်ချက်ပြည့်မီ။ လုံခြုံ။

## Tool parameters

### `run`

tool mode ဖြင့် pipeline ကို လည်ပတ်စေသည်။

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

args များဖြင့် workflow ဖိုင်ကို လည်ပတ်စေသည်-

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

အတည်ပြုပြီးနောက် ရပ်တန့်ထားသော workflow ကို ဆက်လက်လုပ်ဆောင်သည်။

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: Lobster binary ၏ absolute path (မပေးပါက `PATH` ကို အသုံးပြုသည်)။
- `cwd`: pipeline အတွက် working directory (မူလမှာ လက်ရှိ process working directory)။
- `timeoutMs`: သတ်မှတ်ထားသော အချိန်ကို ကျော်လွန်ပါက subprocess ကို သတ်ပစ်သည် (default: 20000)။
- `maxStdoutBytes`: stdout အရွယ်အစားသည် ဤအရွယ်အစားကို ကျော်လွန်ပါက subprocess ကို သတ်ပစ်သည် (default: 512000)။
- `argsJson`: `lobster run --args-json` သို့ ပေးပို့သော JSON string (workflow ဖိုင်များအတွက်သာ)။

## Output envelope

Lobster သည် အခြေအနေ သုံးမျိုးအနက် တစ်ခုဖြင့် JSON envelope ကို ပြန်ပေးသည်-

- `ok` → အောင်မြင်စွာ ပြီးဆုံး
- `needs_approval` → ရပ်တန့်ထားသည်; ပြန်လည်စတင်ရန် `requiresApproval.resumeToken` လိုအပ်သည်
- `cancelled` → ထင်ရှားစွာ ငြင်းပယ် သို့မဟုတ် ဖျက်သိမ်းထားသည်

tool သည် envelope ကို `content` (pretty JSON) နှင့် `details` (raw object) နှစ်မျိုးစလုံးဖြင့် ပြသပေးသည်။

## Approvals

`requiresApproval` ရှိပါက prompt ကို စစ်ဆေးပြီး ဆုံးဖြတ်ပါ-

- `approve: true` → ဆက်လက်လုပ်ဆောင်ပြီး အကျိုးသက်ရောက်မှုများကို ဆောင်ရွက်ရန်
- `approve: false` → ဖျက်သိမ်းပြီး workflow ကို အပြီးသတ်ရန်

custom jq/heredoc glue မလိုဘဲ approval request များတွင် JSON preview ကို တွဲဖက်ရန် `approve --preview-from-stdin --limit N` ကို အသုံးပြုပါ။ ယခု resume token များသည် သေးငယ်လာပြီး Lobster သည် workflow resume state ကို ၎င်း၏ state dir အောက်တွင် သိမ်းဆည်းကာ token key သေးငယ်တစ်ခုကိုသာ ပြန်ပေးပါသည်။

## OpenProse

OpenProse သည် Lobster နှင့် ကောင်းစွာ တွဲဖက်အသုံးပြုနိုင်သည်- multi-agent prep ကို `/prose` ဖြင့် စီမံခန့်ခွဲပြီး ထို့နောက် သတ်မှတ်ချက်ပြည့်မီသော အတည်ပြုချက်များအတွက် Lobster pipeline ကို လည်ပတ်ပါ။ Prose program တစ်ခုတွင် Lobster လိုအပ်ပါက `tools.subagents.tools` မှတစ်ဆင့် sub-agent များအတွက် `lobster` tool ကို ခွင့်ပြုပါ။ [OpenProse](/prose) ကို ကြည့်ပါ။

## Safety

- **Local subprocess only** — plugin ကိုယ်တိုင်မှ network call များ မလုပ်ပါ။
- **No secrets** — Lobster သည် OAuth ကို မစီမံပါ; OpenClaw tools များကိုသာ ခေါ်ပါသည်။
- **Sandbox-aware** — tool context သည် sandboxed ဖြစ်ပါက ပိတ်ထားပါသည်။
- **Hardened** — သတ်မှတ်ပါက `lobsterPath` သည် absolute ဖြစ်ရမည်; timeout နှင့် output cap များကို အတည်ပြုအကောင်အထည်ဖော်ထားသည်။

## Troubleshooting

- **`lobster subprocess timed out`** → `timeoutMs` ကို တိုးမြှင့်ပါ၊ သို့မဟုတ် pipeline ရှည်လျားမှုကို ခွဲပါ။
- **`lobster output exceeded maxStdoutBytes`** → `maxStdoutBytes` ကို မြှင့်ပါ သို့မဟုတ် output အရွယ်အစားကို လျှော့ချပါ။
- **`lobster returned invalid JSON`** → pipeline ကို tool mode ဖြင့် လည်ပတ်ပြီး JSON သာ ထုတ်ပေးကြောင်း သေချာပါစေ။
- **`lobster failed (code …)`** → stderr ကို စစ်ဆေးရန် terminal တွင် တူညီသော pipeline ကို လည်ပတ်ပါ။

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

အများပြည်သူအသုံးပြု ဥပမာတစ်ခုမှာ “second brain” CLI + Lobster pipelines ဖြစ်ပြီး Markdown vault သုံးခု (ကိုယ်ပိုင်၊ မိတ်ဖက်၊ မျှဝေထားသော) ကို စီမံခန့်ခွဲသည်။ CLI သည် stats၊ inbox စာရင်းများ၊ နှင့် stale scan များအတွက် JSON ကို ထုတ်ပေးပြီး Lobster သည် ထို command များကို `weekly-review`, `inbox-triage`, `memory-consolidation`, နှင့် `shared-task-sync` ကဲ့သို့ workflow များအဖြစ် ချိတ်ဆက်ကာ အတည်ပြုချက်ဂိတ်များ ထည့်သွင်းထားသည်။ AI သည် ရရှိနိုင်ပါက ဆုံးဖြတ်ချက်များ (အမျိုးအစားခွဲခြားခြင်း) ကို ကိုင်တွယ်ပြီး မရရှိပါက သတ်မှတ်ချက်ပြည့်မီသော စည်းမျဉ်းများသို့ ပြန်လှည့်အသုံးပြုသည်။

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
