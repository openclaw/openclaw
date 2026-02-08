---
summary: "OpenClaw စနစ်ပရောမ့်တွင် ပါဝင်သည့် အကြောင်းအရာများနှင့် ၎င်းကို မည်သို့ စုစည်းတည်ဆောက်ထားသည်"
read_when:
  - စနစ်ပရောမ့် စာသား၊ ကိရိယာစာရင်း သို့မဟုတ် အချိန်/heartbeat အပိုင်းများကို ပြင်ဆင်သည့်အခါ
  - workspace bootstrap သို့မဟုတ် Skills ထည့်သွင်းပုံအပြုအမူကို ပြောင်းလဲသည့်အခါ
title: "System Prompt"
x-i18n:
  source_path: concepts/system-prompt.md
  source_hash: 1de1b529402a5f1b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:29Z
---

# System Prompt

OpenClaw သည် agent run တစ်ကြိမ်ချင်းစီအတွက် ကိုယ်ပိုင် system prompt ကို တည်ဆောက်ပေးပါသည်။ ထို prompt သည် **OpenClaw ပိုင်ဆိုင်မှု** ဖြစ်ပြီး p-coding-agent ၏ default prompt ကို မသုံးပါ။

ထို prompt ကို OpenClaw က စုစည်းပြီး agent run တစ်ခုချင်းစီထဲသို့ ထည့်သွင်းပေးပါသည်။

## Structure

Prompt ကို ရည်ရွယ်ချက်ရှိရှိ ကျစ်လစ်အောင် ထားရှိပြီး တိတိကျကျ သတ်မှတ်ထားသော အပိုင်းများကို အသုံးပြုပါသည်–

- **Tooling**: လက်ရှိ ကိရိယာစာရင်း + အကျဉ်းချုပ်ဖော်ပြချက်များ။
- **Safety**: အာဏာရှာဖွေသည့် အပြုအမူများ သို့မဟုတ် oversight ကို ကျော်လွှားရန် ကြိုးပမ်းမှုများကို ရှောင်ရှားရန် အတိုချုပ် သတိပေးချက်။
- **Skills** (ရရှိနိုင်ပါက): လိုအပ်သည့်အချိန်တွင် skill ညွှန်ကြားချက်များကို မည်သို့ load လုပ်ရမည်ကို မော်ဒယ်အား ပြောကြားပေးသည်။
- **OpenClaw Self-Update**: `config.apply` နှင့် `update.run` ကို မည်သို့ လည်ပတ်ရမည်။
- **Workspace**: အလုပ်လုပ်သည့် ဒိုင်ရက်ထရီ (`agents.defaults.workspace`)။
- **Documentation**: OpenClaw docs ၏ local path (repo သို့မဟုတ် npm package) နှင့် ၎င်းတို့ကို မည်သည့်အချိန်တွင် ဖတ်သင့်သည်ကို ဖော်ပြသည်။
- **Workspace Files (injected)**: bootstrap ဖိုင်များကို အောက်တွင် ထည့်သွင်းထားကြောင်း ပြသသည်။
- **Sandbox** (အသုံးပြုထားပါက): sandboxed runtime၊ sandbox paths နှင့် elevated exec ရရှိနိုင်ခြင်း ရှိ/မရှိကို ဖော်ပြသည်။
- **Current Date & Time**: အသုံးပြုသူ၏ local အချိန်၊ timezone နှင့် အချိန်ဖော်ပြပုံစံ။
- **Reply Tags**: ပံ့ပိုးထားသော provider များအတွက် optional reply tag syntax။
- **Heartbeats**: heartbeat prompt နှင့် ack အပြုအမူ။
- **Runtime**: ဟို့စ်၊ OS၊ node၊ model၊ repo root (ရှာဖွေတွေ့ရှိပါက)၊ thinking level (တစ်ကြောင်းတည်း)။
- **Reasoning**: လက်ရှိ မြင်နိုင်မှုအဆင့် + /reasoning toggle အညွှန်း။

System prompt ထဲရှိ safety guardrails များသည် အကြံပြုချက်သဘောသာ ဖြစ်ပါသည်။ မော်ဒယ်၏ အပြုအမူကို လမ်းညွှန်ပေးသော်လည်း မူဝါဒကို မတင်းကြပ်စေပါ။ တင်းကြပ်သည့် အကောင်အထည်ဖော်မှုအတွက် tool policy၊ exec approvals၊ sandboxing နှင့် channel allowlists များကို အသုံးပြုပါ; ဒီဇိုင်းအရ operator များက ၎င်းတို့ကို ပိတ်ထားနိုင်ပါသည်။

## Prompt modes

OpenClaw သည် sub-agent များအတွက် ပိုမိုသေးငယ်သော system prompt များကို ထုတ်ပေးနိုင်ပါသည်။ Runtime သည် run တစ်ကြိမ်ချင်းစီအတွက်
`promptMode` ကို သတ်မှတ်ပေးပါသည် (အသုံးပြုသူကို မျက်နှာချင်းဆိုင် မပြသသော config ဖြစ်သည်)–

- `full` (default): အထက်ဖော်ပြပါ အပိုင်းများအားလုံး ပါဝင်သည်။
- `minimal`: sub-agent များအတွက် အသုံးပြုသည်; **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies**, နှင့် **Heartbeats** ကို ဖယ်ရှားထားသည်။ Tooling၊ **Safety**,
  Workspace၊ Sandbox၊ Current Date & Time (သိရှိပါက)၊ Runtime နှင့် injected
  context များကို ဆက်လက် အသုံးပြုနိုင်ပါသည်။
- `none`: အခြေခံ identity စာကြောင်းတစ်ကြောင်းသာ ပြန်ပေးသည်။

`promptMode=minimal` ဖြစ်ပါက၊ ထပ်မံ ထည့်သွင်းသည့် prompt များကို **Group Chat Context** အစား **Subagent
Context** ဟု အမည်တပ်ပါသည်။

## Workspace bootstrap injection

Bootstrap ဖိုင်များကို ဖြတ်တောက်ပြီး **Project Context** အောက်တွင် ဆက်လက် ထည့်သွင်းထားသဖြင့် မော်ဒယ်သည် identity နှင့် profile context ကို အထူးဖတ်ရန် မလိုဘဲ မြင်နိုင်ပါသည်–

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (အသစ်စက်စက် workspace များတွင်သာ)

ဖိုင်အရွယ်အစားကြီးမားပါက marker တစ်ခုဖြင့် ဖြတ်တောက်ထားပါသည်။ ဖိုင်တစ်ခုချင်းစီအတွက် အများဆုံး အရွယ်အစားကို
`agents.defaults.bootstrapMaxChars` (default: 20000) ဖြင့် ထိန်းချုပ်ပါသည်။ မရှိသော ဖိုင်များအတွက်
short missing-file marker ကို ထည့်သွင်းပါသည်။

Internal hooks များသည် `agent:bootstrap` မှတစ်ဆင့် ဤအဆင့်ကို ကြားဖြတ်၍ injected bootstrap ဖိုင်များကို ပြောင်းလဲ သို့မဟုတ် အစားထိုးနိုင်ပါသည် (ဥပမာ `SOUL.md` ကို အခြား persona တစ်ခုဖြင့် လဲလှယ်ခြင်း)။

Injected ဖိုင်တစ်ခုချင်းစီက context အပေါ် မည်မျှ အကျိုးသက်ရောက်မှုရှိသည်ကို (raw vs injected၊ truncation နှင့် tool schema overhead အပါအဝင်) စစ်ဆေးရန် `/context list` သို့မဟုတ် `/context detail` ကို အသုံးပြုပါ။ [Context](/concepts/context) ကို ကြည့်ပါ။

## Time handling

အသုံးပြုသူ၏ timezone ကို သိရှိထားပါက system prompt တွင် သီးသန့် **Current Date & Time** အပိုင်းကို ထည့်သွင်းပါသည်။ Prompt ကို cache-stable ဖြစ်စေရန် ယခုအခါ
**time zone** ကိုသာ ထည့်သွင်းထားပြီး (dynamic clock သို့မဟုတ် time format မပါဝင်ပါ)။

Agent ကို လက်ရှိအချိန် လိုအပ်သည့်အခါ `session_status` ကို အသုံးပြုပါ; status card တွင် timestamp စာကြောင်း ပါဝင်ပါသည်။

အောက်ပါအတိုင်း configure လုပ်နိုင်ပါသည်–

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

အပြည့်အစုံ အပြုအမူအသေးစိတ်ကို [Date & Time](/date-time) တွင် ကြည့်ပါ။

## Skills

သင့်လျော်သော Skills များ ရှိပါက OpenClaw သည် ကျစ်လစ်သော **available skills list**
(`formatSkillsForPrompt`) ကို ထည့်သွင်းပေးပါသည်။ ထိုစာရင်းတွင် skill တစ်ခုချင်းစီ၏ **file path** ပါဝင်ပါသည်။
Prompt သည် မော်ဒယ်အား စာရင်းထဲတွင် ဖော်ပြထားသော တည်နေရာ (workspace, managed, သို့မဟုတ် bundled) မှ SKILL.md ကို load လုပ်ရန် `read` ကို အသုံးပြုရန် ညွှန်ကြားပါသည်။ Skills မရှိပါက
Skills အပိုင်းကို မထည့်သွင်းပါ။

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

ဤနည်းလမ်းကြောင့် base prompt ကို သေးငယ်စွာ ထားနိုင်ပြီး လိုအပ်သည့် skill များကိုသာ ထိရောက်စွာ အသုံးပြုနိုင်ပါသည်။

## Documentation

ရရှိနိုင်ပါက system prompt တွင် **Documentation** အပိုင်းကို ထည့်သွင်းပြီး
local OpenClaw docs directory ကို ညွှန်ပြပါသည် (repo workspace အတွင်းရှိ `docs/` သို့မဟုတ် bundled npm
package docs)။ ထို့အပြင် public mirror၊ source repo၊ community Discord နှင့်
Skills ရှာဖွေရန် ClawHub ([https://clawhub.com](https://clawhub.com)) ကိုလည်း မှတ်သားဖော်ပြပါသည်။ Prompt သည် OpenClaw ၏ အပြုအမူ၊ အမိန့်များ၊ ဖွဲ့စည်းပြင်ဆင်မှု သို့မဟုတ် architecture အကြောင်း သိရှိရန် local docs ကို ဦးစွာ ကိုးကားရန် မော်ဒယ်အား ညွှန်ကြားပြီး၊ ဖြစ်နိုင်ပါက ကိုယ်တိုင် `openclaw status` ကို လည်ပတ်ရန် (ဝင်ရောက်ခွင့် မရှိသောအခါတွင်သာ အသုံးပြုသူအား မေးမြန်းရန်) ညွှန်ကြားပါသည်။
