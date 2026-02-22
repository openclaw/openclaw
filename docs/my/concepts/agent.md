---
summary: "Agent runtime (embedded pi-mono), workspace စာချုပ်နှင့် session bootstrap"
read_when:
  - Agent runtime၊ workspace bootstrap သို့မဟုတ် session အပြုအမူကို ပြောင်းလဲသောအခါ
title: "Agent Runtime"
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

Blank ဖိုင်များကို skip လုပ်ပါသည်။ Prompt များကို ပေါ့ပါးစေရန် large ဖိုင်များကို marker ပါအောင် trim နှင့် truncate လုပ်ပါသည် (အပြည့်အစုံအတွက် ဖိုင်ကို ဖတ်ပါ)။

ဖိုင်တစ်ခု မရှိပါက OpenClaw သည် “missing file” marker လိုင်းတစ်ကြောင်းတည်းကို ထည့်သွင်းပေးပြီး (`openclaw setup` သည် လုံခြုံသော default template တစ်ခုကို ဖန်တီးပေးပါသည်)။

`BOOTSTRAP.md` ကို **brand new workspace** (အခြား bootstrap ဖိုင်များ မရှိသေးသောအခါ) တွင်သာ ဖန်တီးပါသည်။ Ritual ကို ပြီးဆုံးပြီးနောက် delete လုပ်ပါက နောက်ပိုင်း restart များတွင် ပြန်မဖန်တီးသင့်ပါ။

Bootstrap ဖိုင် ဖန်တီးမှုကို လုံးဝပိတ်လိုပါက (pre-seeded workspaces အတွက်) အောက်ပါအတိုင်း သတ်မှတ်ပါ —

```json5
{ agent: { skipBootstrap: true } }
```

## Built-in tools

Core tools (read/exec/edit/write နှင့် ဆက်စပ် system tools) များသည် tool policy အပေါ်မူတည်၍ အမြဲတမ်း အသုံးပြုနိုင်ပါသည်။ `apply_patch` သည် optional ဖြစ်ပြီး `tools.exec.applyPatch` ဖြင့် gate လုပ်ထားပါသည်။ `TOOLS.md` သည် ဘယ် tools ရှိသလဲကို မထိန်းချုပ်ပါ၊ _သင်_ အလိုရှိသည့် အသုံးပြုပုံအတွက် guidance ပေးခြင်းသာ ဖြစ်ပါသည်။

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

Session ID သည် stable ဖြစ်ပြီး OpenClaw မှ ရွေးချယ်ပေးပါသည်။
Legacy Pi/Tau session folder များကို **မဖတ်ပါ**။

## Streaming လုပ်နေစဉ် Steering

Queue mode သည် `steer` ဖြစ်သောအခါ inbound message များကို လက်ရှိ run ထဲသို့ inject လုပ်ပါသည်။
Queue ကို **tool call တစ်ခါစီအပြီး** စစ်ဆေးပါသည်၊ queued message ရှိပါက လက်ရှိ assistant message ထဲမှ ကျန် tool call များကို skip လုပ်ပါသည် ("Skipped due to queued user message." ဟု error tool result ပြပါမည်)၊ ထို့နောက် နောက် assistant response မတိုင်မီ queued user message ကို inject လုပ်ပါသည်။

Queue mode သည် `followup` သို့မဟုတ် `collect` ဖြစ်သောအခါ inbound message များကို လက်ရှိ turn ပြီးဆုံးသည်အထိ ထိန်းထားပြီး နောက်တစ်ကြိမ် agent turn အသစ်ကို queued payload များနှင့် စတင်ပါသည်။ Mode နှင့် debounce/cap behavior အတွက် [Queue](/concepts/queue) ကို ကြည့်ပါ။

Block streaming သည် assistant block များ ပြီးဆုံးသည်နှင့် ချက်ချင်းပို့ပါသည်၊ default အနေဖြင့် **off** ဖြစ်ပါသည် (`agents.defaults.blockStreamingDefault: "off"`)။
`agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; default သည် text_end) ဖြင့် boundary ကို tune လုပ်ပါ။
`agents.defaults.blockStreamingChunk` (default: 800–1200 chars; paragraph break ကို ဦးစားပေးပြီး နောက် newline၊ နောက်ဆုံး sentence) ဖြင့် soft block chunking ကို ထိန်းချုပ်ပါ။
Single-line spam လျော့ချရန် streamed chunk များကို `agents.defaults.blockStreamingCoalesce` ဖြင့် coalesce လုပ်ပါ (idle အခြေပြု merging ဖြင့် ပို့မီ ပေါင်းစည်းခြင်း)။ Telegram မဟုတ်သော channel များတွင် block reply ကို ဖွင့်ရန် `*.blockStreaming: true` ကို အထူးသတ်မှတ်ရပါသည်။
Verbose tool summary များကို tool start အချိန်တွင် (debounce မရှိ) ထုတ်ပေးပါသည်၊ Control UI သည် ရရှိနိုင်ပါက agent event များမှ tool output ကို stream လုပ်ပါသည်။
အသေးစိတ်အချက်အလက်များ: [Streaming + chunking](/concepts/streaming)။

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
