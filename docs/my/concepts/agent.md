---
summary: "Agent runtime (embedded pi-mono), workspace စာချုပ်နှင့် session bootstrap"
read_when:
  - Agent runtime၊ workspace bootstrap သို့မဟုတ် session အပြုအမူကို ပြောင်းလဲသောအခါ
title: "Agent Runtime"
x-i18n:
  source_path: concepts/agent.md
  source_hash: 121103fda29a5481
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:26Z
---

# Agent Runtime 🤖

OpenClaw သည် **pi-mono** မှ ဆင်းသက်လာသော embedded agent runtime တစ်ခုတည်းကို လည်ပတ်အသုံးပြုပါသည်။

## Workspace (မဖြစ်မနေလိုအပ်)

OpenClaw သည် agent ၏ **တစ်ခုတည်းသော** အလုပ်လုပ်ရာ ဒိုင်ရက်ထရီ (`cwd`) အဖြစ် agent workspace ဒိုင်ရက်ထရီ တစ်ခုတည်း (`agents.defaults.workspace`) ကို အသုံးပြုပါသည်။ ၎င်းကို tools နှင့် context အတွက် အသုံးပြုပါသည်။

အကြံပြုချက် — `openclaw setup` ကို အသုံးပြုပြီး မရှိသေးပါက `~/.openclaw/openclaw.json` ကို ဖန်တီးကာ workspace ဖိုင်များကို စတင်အဆင်သင့် ပြုလုပ်ပါ။

Workspace အပြည့်အစုံ ဖွဲ့စည်းပုံနှင့် backup လမ်းညွှန် — [Agent workspace](/concepts/agent-workspace)

`agents.defaults.sandbox` ကို ဖွင့်ထားပါက main မဟုတ်သော sessions များသည်
`agents.defaults.sandbox.workspaceRoot` အောက်ရှိ per-session workspaces ဖြင့် ယင်းကို override လုပ်နိုင်ပါသည် ( [Gateway configuration](/gateway/configuration) ကို ကြည့်ပါ )။

## Bootstrap ဖိုင်များ (ထည့်သွင်းပေးထားသည်)

`agents.defaults.workspace` အတွင်းတွင် OpenClaw သည် အောက်ပါ user-editable ဖိုင်များကို မျှော်မှန်းထားပါသည် —

- `AGENTS.md` — လည်ပတ်အသုံးပြုရန် ညွှန်ကြားချက်များ + “memory”
- `SOUL.md` — persona၊ ကန့်သတ်ချက်များ၊ tone
- `TOOLS.md` — user မှ ထိန်းသိမ်းထားသော tool မှတ်စုများ (ဥပမာ `imsg`၊ `sag`၊ conventions)
- `BOOTSTRAP.md` — ပထမဆုံး run တွင်သာ လုပ်ဆောင်ရသော ritual (ပြီးဆုံးပြီးနောက် ဖျက်ပစ်သည်)
- `IDENTITY.md` — agent အမည် / vibe / emoji
- `USER.md` — user profile + နှစ်သက်သော ခေါ်ဝေါ်ပုံ

Session အသစ်တစ်ခု၏ ပထမဆုံး turn တွင် OpenClaw သည် ဤဖိုင်များ၏ အကြောင်းအရာများကို agent context ထဲသို့ တိုက်ရိုက် ထည့်သွင်းပေးပါသည်။

ဗလာဖိုင်များကို ချန်လှပ်ထားပါသည်။ ဖိုင်ကြီးများကို prompt များ ပိုမိုကျစ်လစ်စေရန် marker တစ်ခုဖြင့် ဖြတ်တောက်ကာ ချုံ့ပါသည် (အပြည့်အစုံကို ဖတ်ရန် ဖိုင်ကို တိုက်ရိုက်ဖတ်ပါ)။

ဖိုင်တစ်ခု မရှိပါက OpenClaw သည် “missing file” marker လိုင်းတစ်ကြောင်းတည်းကို ထည့်သွင်းပေးပြီး (`openclaw setup` သည် လုံခြုံသော default template တစ်ခုကို ဖန်တီးပေးပါသည်)။

`BOOTSTRAP.md` ကို **အသစ်စက်စက် workspace** (အခြား bootstrap ဖိုင်များ မရှိသေးသောအခါ) အတွက်သာ ဖန်တီးပါသည်။ Ritual ပြီးဆုံးပြီးနောက် ဖျက်ပစ်လိုက်ပါက နောက်တစ်ကြိမ် ပြန်လည်စတင်ရာတွင် ပြန်မဖန်တီးသင့်ပါ။

Bootstrap ဖိုင် ဖန်တီးမှုကို လုံးဝပိတ်လိုပါက (pre-seeded workspaces အတွက်) အောက်ပါအတိုင်း သတ်မှတ်ပါ —

```json5
{ agent: { skipBootstrap: true } }
```

## Built-in tools

အဓိက tools များ (read/exec/edit/write နှင့် ဆက်စပ် system tools များ) ကို tool policy အရ အမြဲရရှိနိုင်ပါသည်။
`apply_patch` သည် ရွေးချယ်နိုင်ပြီး `tools.exec.applyPatch` ဖြင့် ကန့်သတ်ထားပါသည်။
`TOOLS.md` သည် ဘယ် tools များ ရှိ/မရှိ ကို မထိန်းချုပ်ပါ — ၎င်းသည် _သင်_ tools များကို မည်သို့ အသုံးပြုစေလိုသည်ကို ညွှန်ပြသည့် လမ်းညွှန်ချက်သာ ဖြစ်ပါသည်။

## Skills

OpenClaw သည် Skills များကို အောက်ပါ နေရာ ၃ ခုမှ load လုပ်ပါသည် (အမည် တူညီပါက workspace သည် ဦးစားပေး) —

- Bundled (install အတွင်း ပါဝင်ပို့ဆောင်လာသော)
- Managed/local: `~/.openclaw/skills`
- Workspace: `<workspace>/skills`

Skills များကို config/env ဖြင့် ကန့်သတ်နိုင်ပါသည် (`skills` ကို [Gateway configuration](/gateway/configuration) တွင် ကြည့်ပါ)။

## pi-mono ပေါင်းစည်းမှု

OpenClaw သည် pi-mono codebase ၏ အချို့အစိတ်အပိုင်းများ (models/tools) ကို ပြန်လည်အသုံးပြုသော်လည်း **session management၊ discovery နှင့် tool wiring များကို OpenClaw ကိုယ်တိုင် ပိုင်ဆိုင်ထားပါသည်**။

- pi-coding agent runtime မရှိပါ။
- `~/.pi/agent` သို့မဟုတ် `<workspace>/.pi` ဆိုင်ရာ setting များကို မစစ်ဆေးပါ။

## Sessions

Session transcript များကို JSONL အဖြစ် အောက်ပါနေရာတွင် သိမ်းဆည်းထားပါသည် —

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

Session ID သည် တည်ငြိမ်ပြီး OpenClaw က ရွေးချယ်ပေးပါသည်။
Legacy Pi/Tau session ဖိုလ်ဒါများကို **မဖတ်ပါ**။

## Streaming လုပ်နေစဉ် Steering

Queue mode သည် `steer` ဖြစ်သောအခါ ဝင်လာသော မက်ဆေ့ချ်များကို လက်ရှိ run ထဲသို့ ထည့်သွင်းပါသည်။
Queue ကို **tool call တစ်ကြိမ်စီပြီးနောက်** စစ်ဆေးပါသည်။ Queue ထဲတွင် မက်ဆေ့ချ် ရှိနေပါက လက်ရှိ assistant မက်ဆေ့ချ်မှ ကျန်ရှိသော tool calls များကို ကျော်လွှားပစ်ပါသည် (error tool result များတွင် "Skipped due to queued user message." ဟု ပြသမည်)။ ထို့နောက် နောက်ထပ် assistant response မတိုင်မီ queued user message ကို ထည့်သွင်းပါသည်။

Queue mode သည် `followup` သို့မဟုတ် `collect` ဖြစ်ပါက ဝင်လာသော မက်ဆေ့ချ်များကို လက်ရှိ turn ပြီးဆုံးသည်အထိ ထိန်းထားပြီး ထို့နောက် queued payload များဖြင့် agent turn အသစ်ကို စတင်ပါသည်။
Mode နှင့် debounce/cap အပြုအမူများအတွက် [Queue](/concepts/queue) ကို ကြည့်ပါ။

Block streaming သည် assistant block များ ပြီးဆုံးသည်နှင့် ချက်ချင်း ပို့ပါသည်။ ၎င်းကို **ပုံမှန်အားဖြင့် ပိတ်ထားပါသည်** (`agents.defaults.blockStreamingDefault: "off"`)။
Boundary ကို `agents.defaults.blockStreamingBreak` ဖြင့် ချိန်ညှိနိုင်ပါသည် (`text_end` နှင့် `message_end` အကြား; default သည် text_end)။
Soft block chunking ကို `agents.defaults.blockStreamingChunk` ဖြင့် ထိန်းချုပ်နိုင်ပါသည် (default 800–1200 chars; paragraph breaks ကို ဦးစားပေး၊ ထို့နောက် newlines၊ နောက်ဆုံး sentences)။
Streamed chunks များကို `agents.defaults.blockStreamingCoalesce` ဖြင့် ပေါင်းစည်းနိုင်ပြီး single-line spam ကို လျှော့ချနိုင်ပါသည် (ပို့မီ idle-based merging)။
Telegram မဟုတ်သော ချန်နယ်များတွင် block replies ကို ဖွင့်ရန် အထူး `*.blockStreaming: true` လိုအပ်ပါသည်။
Verbose tool summaries များကို tool စတင်ချိန်တွင် ထုတ်လွှတ်ပါသည် (debounce မရှိ)။ Control UI သည် ရရှိနိုင်ပါက agent events မှတစ်ဆင့် tool output ကို stream လုပ်ပါသည်။
အသေးစိတ် — [Streaming + chunking](/concepts/streaming)။

## Model refs

Config အတွင်းရှိ model refs များ (ဥပမာ `agents.defaults.model` နှင့် `agents.defaults.models`) ကို **ပထမဆုံး** `/` တွင် ခွဲခြမ်းစိတ်ဖြာပါသည်။

- Model များကို configure လုပ်ရာတွင် `provider/model` ကို အသုံးပြုပါ။
- Model ID ကိုယ်တိုင်တွင် `/` (OpenRouter-style) ပါဝင်နေပါက provider prefix ကို ထည့်သွင်းပါ (ဥပမာ — `openrouter/moonshotai/kimi-k2`)။
- Provider ကို မထည့်ပါက OpenClaw သည် input ကို alias သို့မဟုတ် **default provider** အတွက် model ဟု သတ်မှတ်ပါသည် (model ID အတွင်း `/` မရှိသောအခါသာ အလုပ်လုပ်ပါသည်)။

## Configuration (အနည်းဆုံး)

အနည်းဆုံး အောက်ပါတို့ကို သတ်မှတ်ပါ —

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (အထူးအကြံပြု)

---

_နောက်တစ်ခု — [Group Chats](/channels/group-messages)_ 🦞
