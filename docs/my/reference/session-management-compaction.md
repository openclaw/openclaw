---
summary: "နက်ရှိုင်းစွာရှင်းလင်းချက်: session store + transcript များ၊ lifecycle နှင့် (auto)compaction အတွင်းပိုင်းလုပ်ဆောင်ပုံ"
read_when:
  - Session id များ၊ transcript JSONL သို့မဟုတ် sessions.json fields များကို debug လုပ်ရန် လိုအပ်သောအခါ
  - Auto-compaction အပြုအမူကို ပြောင်းလဲနေစဉ် သို့မဟုတ် “pre-compaction” housekeeping ကို ထည့်သွင်းနေစဉ်
  - Memory flush များ သို့မဟုတ် silent system turns များကို အကောင်အထည်ဖော်လိုသည့်အခါ
title: "Session Management နက်ရှိုင်းစွာရှင်းလင်းချက်"
x-i18n:
  source_path: reference/session-management-compaction.md
  source_hash: 6344a9eaf8797eb4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:29Z
---

# Session Management & Compaction (နက်ရှိုင်းစွာရှင်းလင်းချက်)

ဤစာရွက်စာတမ်းသည် OpenClaw က session များကို အဆုံးမှအဆုံး ဘယ်လို စီမံခန့်ခွဲသလဲကို ရှင်းပြထားသည် —

- **Session routing** (ဝင်လာသော မက်ဆေ့ချ်များကို `sessionKey` သို့ မည်သို့ မြေပုံချသတ်မှတ်သလဲ)
- **Session store** (`sessions.json`) နှင့် ၎င်းတွင် မည်သည့်အရာများကို ခြေရာခံထားသည်
- **Transcript persistence** (`*.jsonl`) နှင့် ၎င်း၏ ဖွဲ့စည်းပုံ
- **Transcript hygiene** (run မလုပ်မီ provider အလိုက် ပြုပြင်ညှိနှိုင်းမှုများ)
- **Context limits** (context window နှင့် tracked tokens တို့၏ ကွာခြားချက်)
- **Compaction** (manual + auto-compaction) နှင့် pre-compaction အလုပ်များကို ချိတ်ဆက်သင့်သည့် နေရာ
- **Silent housekeeping** (ဥပမာ—အသုံးပြုသူမြင်နိုင်သော output မထုတ်သင့်သော memory write များ)

အရင်ဆုံး အမြင့်အဆင့်အမြင်တစ်ခုလိုပါက အောက်ပါတို့မှ စတင်ဖတ်ရှုနိုင်သည် —

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## Source of truth: Gateway

OpenClaw ကို session state ကို ကိုင်တွယ်ပိုင်ဆိုင်သော **Gateway process တစ်ခုတည်း** ကို အခြေခံအုတ်မြစ်အဖြစ် ဒီဇိုင်းလုပ်ထားသည်။

- UI များ (macOS app, web Control UI, TUI) သည် session စာရင်းများနှင့် token အရေအတွက်များကို Gateway မှ မေးမြန်းသင့်သည်။
- Remote mode တွင် session ဖိုင်များသည် remote host ပေါ်တွင် ရှိသည်။ “သင့် local Mac ဖိုင်များကို စစ်ဆေးခြင်း” သည် Gateway အသုံးပြုနေသည့် အရာများကို မပြသပါ။

---

## Persistence အလွှာ နှစ်ခု

OpenClaw သည် session များကို အလွှာ နှစ်ခုဖြင့် သိမ်းဆည်းထားသည် —

1. **Session store (`sessions.json`)**
   - Key/value map: `sessionKey -> SessionEntry`
   - သေးငယ်ပြီး ပြောင်းလဲနိုင်ကာ ပြင်ဆင်ရန် (သို့မဟုတ် entry များကို ဖျက်ရန်) လုံခြုံသည်
   - Session metadata များ (လက်ရှိ session id, နောက်ဆုံး လှုပ်ရှားချိန်, toggles, token counters စသည်) ကို ခြေရာခံထားသည်

2. **Transcript (`<sessionId>.jsonl`)**
   - Tree ဖွဲ့စည်းပုံပါသော append-only transcript (entries များတွင် `id` + `parentId` ပါရှိ)
   - စကားပြောဆိုမှု အမှန်တကယ်၊ tool calls နှင့် compaction summaries များကို သိမ်းဆည်းထားသည်
   - နောက်လာမည့် turn များအတွက် model context ကို ပြန်တည်ဆောက်ရန် အသုံးပြုသည်

---

## Disk ပေါ်ရှိ နေရာများ

Gateway ဟို့စ်ပေါ်တွင် အေးဂျင့်တစ်ခုချင်းစီအလိုက် —

- Store: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transcripts: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram topic sessions: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw သည် `src/config/sessions.ts` မှတစ်ဆင့် ဤနေရာများကို ဖြေရှင်းသတ်မှတ်သည်။

---

## Session keys (`sessionKey`)

`sessionKey` သည် _သင်ရောက်ရှိနေသော စကားပြောဆိုမှု အုပ်စု_ ကို ခွဲခြားသတ်မှတ်ပေးသည် (routing + isolation)။

အများအားဖြင့် တွေ့ရသော ပုံစံများ —

- Main/direct chat (အေးဂျင့်တစ်ခုချင်းစီ): `agent:<agentId>:<mainKey>` (မူလသတ်မှတ်ချက် `main`)
- Group: `agent:<agentId>:<channel>:group:<id>`
- Room/channel (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` သို့မဟုတ် `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>` (override မလုပ်ထားလျှင်)

Canonical စည်းမျဉ်းများကို [/concepts/session](/concepts/session) တွင် မှတ်တမ်းတင်ထားသည်။

---

## Session ids (`sessionId`)

`sessionKey` တစ်ခုစီသည် လက်ရှိ `sessionId` (စကားပြောကို ဆက်လက်ရေးသားနေသော transcript ဖိုင်) ကို ညွှန်ပြထားသည်။

အတွေ့အကြုံအရ သတိပြုရန် —

- **Reset** (`/new`, `/reset`) လုပ်ပါက ထို `sessionKey` အတွက် `sessionId` အသစ်တစ်ခု ဖန်တီးသည်။
- **Daily reset** (Gateway ဟို့စ်၏ local time အရ မနက် 4:00 AM မူလသတ်မှတ်ချက်) သည် reset boundary ကျော်ပြီးနောက် ပထမဆုံး မက်ဆေ့ချ်တွင် `sessionId` အသစ်တစ်ခု ဖန်တီးသည်။
- **Idle expiry** (`session.reset.idleMinutes` သို့မဟုတ် legacy `session.idleMinutes`) သည် idle window ကျော်ပြီးနောက် မက်ဆေ့ချ် ဝင်လာသည့်အခါ `sessionId` အသစ်တစ်ခု ဖန်တီးသည်။ Daily + idle နှစ်ခုလုံး သတ်မှတ်ထားပါက ပထမဆုံး သက်တမ်းကုန်သည့် အချက်က အနိုင်ရသည်။

Implementation အသေးစိတ် — ဆုံးဖြတ်ချက်သည် `src/auto-reply/reply/session.ts` ထဲရှိ `initSessionState()` တွင် ဖြစ်ပေါ်သည်။

---

## Session store schema (`sessions.json`)

Store ၏ value type သည် `src/config/sessions.ts` ထဲရှိ `SessionEntry` ဖြစ်သည်။

အရေးကြီးသော fields များ (အပြည့်အစုံ မဟုတ်) —

- `sessionId`: လက်ရှိ transcript id ( `sessionFile` မသတ်မှတ်ထားပါက filename ကို ဤအချက်မှ ဆင်းသက်ထုတ်ယူသည်)
- `updatedAt`: နောက်ဆုံး လှုပ်ရှားချိန် timestamp
- `sessionFile`: optional explicit transcript path override
- `chatType`: `direct | group | room` (UI များနှင့် send policy ကို ကူညီသည်)
- `provider`, `subject`, `room`, `space`, `displayName`: group/channel labeling အတွက် metadata
- Toggles:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (session တစ်ခုချင်းစီအလိုက် override)
- Model ရွေးချယ်မှု:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Token counters (အကောင်းဆုံး ကြိုးပမ်းချက် / provider အလိုက် ကွာခြားနိုင်):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: ဤ session key အတွက် auto-compaction ပြီးစီးခဲ့သည့် အကြိမ်ရေ
- `memoryFlushAt`: နောက်ဆုံး pre-compaction memory flush ပြုလုပ်ခဲ့သည့် timestamp
- `memoryFlushCompactionCount`: နောက်ဆုံး flush ပြုလုပ်ခဲ့ချိန်၏ compaction count

Store ကို ပြင်ဆင်နိုင်သော်လည်း အာဏာပိုင်မှာ Gateway ဖြစ်သည် — session များ လည်ပတ်နေစဉ် entry များကို ပြန်ရေးခြင်း သို့မဟုတ် ပြန်လည်ဖြည့်တင်းခြင်း ဖြစ်နိုင်သည်။

---

## Transcript ဖွဲ့စည်းပုံ (`*.jsonl`)

Transcripts များကို `@mariozechner/pi-coding-agent` ၏ `SessionManager` မှ စီမံခန့်ခွဲသည်။

ဖိုင်ပုံစံမှာ JSONL ဖြစ်သည် —

- ပထမလိုင်း: session header (`type: "session"`၊ `id`, `cwd`, `timestamp`, optional `parentSession` ပါဝင်)
- ထို့နောက်: `id` + `parentId` (tree) ပါသော session entries များ

သတိပြုရန် entry အမျိုးအစားများ —

- `message`: user/assistant/toolResult မက်ဆေ့ချ်များ
- `custom_message`: model context ထဲသို့ _ဝင်သည့်_ extension ထည့်သွင်းထားသော မက်ဆေ့ချ်များ (UI မှ ဖျောက်ထားနိုင်)
- `custom`: model context ထဲသို့ _မဝင်သည့်_ extension state
- `compaction`: `firstKeptEntryId` နှင့် `tokensBefore` ပါသော သိမ်းဆည်းထားသည့် compaction summary
- `branch_summary`: tree branch တစ်ခုသို့ လမ်းကြောင်းပြောင်းသည့်အခါ သိမ်းဆည်းထားသော summary

OpenClaw သည် transcript များကို **အလိုအလျောက် ပြုပြင်မလုပ်** ပါ — Gateway သည် ဖတ်/ရေးရန် `SessionManager` ကို အသုံးပြုသည်။

---

## Context windows နှင့် tracked tokens

အရေးပါတာ နှစ်မျိုး ရှိသည် —

1. **Model context window**: model တစ်ခုချင်းစီအလိုက် တင်းကျပ်သော အများဆုံးကန့်သတ်ချက် (model မြင်နိုင်သော tokens)
2. **Session store counters**: `sessions.json` ထဲသို့ ရေးသွင်းထားသော rolling stats ( /status နှင့် dashboards အတွက် အသုံးပြု)

Limit များကို ချိန်ညှိနေပါက —

- Context window သည် model catalog မှ ရလာပြီး (config ဖြင့် override လုပ်နိုင်သည်)။
- Store ထဲရှိ `contextTokens` သည် runtime ခန့်မှန်း/အစီရင်ခံတန်ဖိုးသာ ဖြစ်ပြီး တင်းကျပ်သော အာမခံအဖြစ် မယူဆသင့်ပါ။

ပိုမိုသိရှိရန် [/token-use](/reference/token-use) ကို ကြည့်ပါ။

---

## Compaction: အဓိပ္ပါယ်

Compaction သည် အဟောင်းပိုင်း စကားပြောများကို transcript ထဲရှိ သိမ်းဆည်းထားသော `compaction` entry တစ်ခုအဖြစ် အကျဉ်းချုပ်ပြီး နောက်ဆုံး မက်ဆေ့ချ်များကို မပျက်မယွင်း ထားရှိသည်။

Compaction ပြီးနောက် နောက်လာမည့် turn များတွင် —

- Compaction summary
- `firstKeptEntryId` နောက်ပိုင်း မက်ဆေ့ချ်များ

ကို မြင်ရမည် ဖြစ်သည်။

Compaction သည် **persistent** ဖြစ်သည် (session pruning ကဲ့သို့ မဟုတ်ပါ)။ [/concepts/session-pruning](/concepts/session-pruning) ကို ကြည့်ပါ။

---

## Auto-compaction ဖြစ်ပေါ်သည့်အချိန် (Pi runtime)

Embedded Pi agent တွင် auto-compaction သည် အခြေအနေ နှစ်ခုတွင် ဖြစ်ပေါ်သည် —

1. **Overflow recovery**: model မှ context overflow error ပြန်လာပါက → compact → ပြန်ကြိုးစား။
2. **Threshold maintenance**: အောင်မြင်သော turn တစ်ခုပြီးနောက်၊ အောက်ပါအခါ —

`contextTokens > contextWindow - reserveTokens`

အဓိပ္ပါယ် —

- `contextWindow` သည် model ၏ context window
- `reserveTokens` သည် prompts + နောက်တစ်ကြိမ် model output အတွက် သီးသန့်ထားသော headroom

ဤအရာများသည် Pi runtime semantics ဖြစ်ပြီး (OpenClaw သည် event များကို သုံးစွဲသော်လည်း compact မလုပ်ချိန်ကို ဆုံးဖြတ်တာ Pi ဖြစ်သည်)။

---

## Compaction settings (`reserveTokens`, `keepRecentTokens`)

Pi ၏ compaction settings များသည် Pi settings ထဲတွင် ရှိသည် —

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw သည် embedded runs အတွက် safety floor တစ်ခုကိုလည်း ချမှတ်ထားသည် —

- `compaction.reserveTokens < reserveTokensFloor` ဖြစ်ပါက OpenClaw က မြှင့်တင်ပေးသည်။
- မူလ floor သည် `20000` tokens ဖြစ်သည်။
- Floor ကို ပိတ်ရန် `agents.defaults.compaction.reserveTokensFloor: 0` ကို သတ်မှတ်ပါ။
- အကယ်၍ အရင်ကတည်းက မြင့်မားနေပါက OpenClaw သည် မပြောင်းလဲပါ။

အကြောင်းရင်း — compaction မဖြစ်မနေရောက်မီ multi-turn “housekeeping” (memory write များကဲ့သို့) အတွက် headroom လုံလောက်စွာ ချန်ထားရန်။

Implementation — `src/agents/pi-settings.ts` ထဲရှိ `ensurePiCompactionReserveTokens()`
(`src/agents/pi-embedded-runner.ts` မှ ခေါ်ယူသည်)။

---

## အသုံးပြုသူမြင်နိုင်သော အပြင်အဆင်များ

Compaction နှင့် session state ကို အောက်ပါနေရာများတွင် ကြည့်ရှုနိုင်သည် —

- `/status` (မည်သည့် chat session မဆို)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Verbose mode: `🧹 Auto-compaction complete` + compaction count

---

## Silent housekeeping (`NO_REPLY`)

OpenClaw သည် အသုံးပြုသူ မမြင်သင့်သော အလယ်အလတ် output များရှိသည့် နောက်ခံလုပ်ငန်းများအတွက် “silent” turns များကို ပံ့ပိုးသည်။

သဘောတူညီချက် —

- Assistant သည် “အသုံးပြုသူထံ ပြန်မပို့ပါ” ကို ပြရန် `NO_REPLY` ဖြင့် output ကို စတင်ရမည်။
- OpenClaw သည် delivery layer တွင် ၎င်းကို ဖယ်ရှား/တားဆီးသည်။

`2026.1.10` အချိန်မှစ၍ OpenClaw သည် partial chunk တစ်ခုက `NO_REPLY` ဖြင့် စတင်ပါက **draft/typing streaming** ကိုလည်း တားဆီးထားသည်၊ ထို့ကြောင့် silent operation များအတွင်း အလယ်လမ်း output မပေါက်ကြားပါ။

---

## Pre-compaction “memory flush” (အကောင်အထည်ဖော်ပြီး)

ရည်ရွယ်ချက် — auto-compaction မဖြစ်မီ disk သို့ durable state (ဥပမာ—agent workspace ထဲရှိ `memory/YYYY-MM-DD.md`) ကို ရေးသွင်းပေးသော silent agentic turn တစ်ခုကို လုပ်ဆောင်ရန်၊ ထို့ကြောင့် compaction က အရေးကြီးသော context ကို မဖျက်နိုင်ပါ။

OpenClaw သည် **pre-threshold flush** နည်းလမ်းကို အသုံးပြုသည် —

1. Session context အသုံးပြုမှုကို စောင့်ကြည့်သည်။
2. “Soft threshold” (Pi ၏ compaction threshold ထက် နိမ့်) ကို ကျော်သွားသောအခါ silent
   “memory ကို ယခုရေးပါ” ညွှန်ကြားချက်ကို agent ထံ ပို့သည်။
3. အသုံးပြုသူ မမြင်စေရန် `NO_REPLY` ကို အသုံးပြုသည်။

Config (`agents.defaults.compaction.memoryFlush`) —

- `enabled` (မူလ: `true`)
- `softThresholdTokens` (မူလ: `4000`)
- `prompt` (flush turn အတွက် user message)
- `systemPrompt` (flush turn အတွက် ထပ်တိုး system prompt)

မှတ်ချက်များ —

- မူလ prompt/system prompt တွင် delivery ကို တားဆီးရန် `NO_REPLY` အညွှန်း ပါဝင်သည်။
- Flush ကို compaction cycle တစ်ခုချင်းစီအလိုက် တစ်ကြိမ်သာ လုပ်ဆောင်သည် (`sessions.json` တွင် ခြေရာခံထားသည်)။
- Embedded Pi sessions များတွင်သာ flush လုပ်ဆောင်သည် (CLI backends များတွင် မလုပ်ပါ)။
- Session workspace သည် read-only ဖြစ်ပါက (`workspaceAccess: "ro"` သို့မဟုတ် `"none"`) flush ကို ကျော်လွှားသည်။
- Workspace ဖိုင် ဖွဲ့စည်းပုံနှင့် write patterns များအတွက် [Memory](/concepts/memory) ကို ကြည့်ပါ။

Pi သည် extension API ထဲတွင် `session_before_compact` hook ကိုလည်း ပံ့ပိုးထားသော်လည်း OpenClaw ၏
flush logic သည် လက်ရှိတွင် Gateway ဘက်၌သာ ရှိနေသည်။

---

## Troubleshooting checklist

- Session key မှားနေပါသလား? [/concepts/session](/concepts/session) မှ စတင်ပြီး `/status` ထဲရှိ `sessionKey` ကို အတည်ပြုပါ။
- Store နှင့် transcript မကိုက်ညီပါသလား? Gateway ဟို့စ်နှင့် `openclaw status` မှ store path ကို အတည်ပြုပါ။
- Compaction များလွန်းနေပါသလား? အောက်ပါတို့ကို စစ်ဆေးပါ —
  - model context window (သေးလွန်းခြင်း)
  - compaction settings ( `reserveTokens` သည် model window အတွက် မြင့်လွန်းပါက စောစီးစွာ compaction ဖြစ်နိုင်သည်)
  - tool-result အလွန်များခြင်း: session pruning ကို ဖွင့်/ချိန်ညှိပါ
- Silent turns မှ output ပေါက်ကြားနေပါသလား? ပြန်ကြားချက်သည် `NO_REPLY` (တိကျသော token) ဖြင့် စတင်ထားကြောင်းနှင့် streaming suppression fix ပါဝင်သည့် build ကို အသုံးပြုနေကြောင်း အတည်ပြုပါ။
