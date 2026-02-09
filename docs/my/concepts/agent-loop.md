---
summary: "Agent loop ၏ အသက်တာကာလ၊ စီးကြောင်းများ၊ နှင့် စောင့်ဆိုင်းမှု အဓိပ္ပါယ်များ"
read_when:
  - Agent loop သို့မဟုတ် lifecycle ဖြစ်ရပ်များကို တိတိကျကျ လမ်းညွှန်ချက်အဖြစ် ကြည့်ရှုရန် လိုအပ်သောအခါ
title: "Agent Loop"
---

# Agent Loop (OpenClaw)

Agentic loop ဆိုသည်မှာ agent ၏ “အမှန်တကယ်” run အပြည့်အစုံဖြစ်ပြီး: intake → context assembly → model inference → tool execution → streaming replies → persistence ဖြစ်ပါသည်။ ၎င်းသည် message တစ်ခုကို action များနှင့် final reply အဖြစ် ပြောင်းလဲပေးသည့် အာဏာပိုင် လမ်းကြောင်းဖြစ်ပြီး session state ကို တိကျစွာ ထိန်းသိမ်းထားပါသည်။

OpenClaw တွင် loop တစ်ခုသည် session တစ်ခုလျှင် serialized run တစ်ခုသာဖြစ်ပြီး model စဉ်းစားနေစဉ်၊ tool များကို ခေါ်ယူစဉ်၊ output ကို stream လုပ်စဉ် lifecycle နှင့် stream event များကို ထုတ်လွှတ်ပါသည်။ ဤစာတမ်းသည် ထို authentic loop ကို end-to-end အဖြစ် မည်သို့ ချိတ်ဆက်ထားသည်ကို ရှင်းပြပါသည်။

## Entry points

- Gateway RPC: `agent` နှင့် `agent.wait`။
- CLI: `agent` အမိန့်။

## အလုပ်လုပ်ပုံ (အမြင့်အဆင့်)

1. `agent` RPC သည် params များကို စစ်ဆေးအတည်ပြုပြီး session (sessionKey/sessionId) ကို ဖြေရှင်းကာ session metadata ကို သိမ်းဆည်းပြီး `{ runId, acceptedAt }` ကို ချက်ချင်း ပြန်ပေးသည်။
2. `agentCommand` သည် agent ကို လည်ပတ်စေသည်။
   - model နှင့် thinking/verbose default များကို ဖြေရှင်းသည်
   - Skills snapshot ကို တင်သည်
   - `runEmbeddedPiAgent` (pi-agent-core runtime) ကို ခေါ်သည်
   - embed လုပ်ထားသော loop မှ lifecycle end/error မထုတ်လွှင့်ပါက **lifecycle end/error** ကို ထုတ်လွှင့်သည်
3. `runEmbeddedPiAgent`:
   - per-session နှင့် global queues များဖြင့် run များကို serialized လုပ်သည်
   - model + auth profile ကို ဖြေရှင်းပြီး pi session ကို တည်ဆောက်သည်
   - pi events များကို subscribe လုပ်ပြီး assistant/tool deltas များကို စီးကြောင်းဖြင့် ပို့သည်
   - timeout ကို အကောင်အထည်ဖော်ပြီး ကျော်လွန်ပါက run ကို abort လုပ်သည်
   - payloads နှင့် usage metadata ကို ပြန်ပေးသည်
4. `subscribeEmbeddedPiSession` သည် pi-agent-core ဖြစ်ရပ်များကို OpenClaw `agent` စီးကြောင်းသို့ ချိတ်ဆက်ပေးသည်။
   - tool events => `stream: "tool"`
   - assistant deltas => `stream: "assistant"`
   - lifecycle events => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` သည် `waitForAgentJob` ကို အသုံးပြုသည်။
   - `runId` အတွက် **lifecycle end/error** ကို စောင့်ဆိုင်းသည်
   - returns `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Queueing + concurrency

- Runs များကို session key (session lane) အလိုက် serialized လုပ်ပြီး လိုအပ်ပါက global lane မှတစ်ဆင့် ဖြတ်သန်းစေသည်။
- ၎င်းသည် tool/session race များကို ကာကွယ်ပြီး session history ကို တည်ငြိမ်စေသည်။
- Messaging channel များသည် lane system ကို feed လုပ်ပေးသော queue mode များ (collect/steer/followup) ကို ရွေးချယ်နိုင်ပါသည်။
  [Command Queue](/concepts/queue) ကို ကြည့်ပါ။

## Session + workspace ပြင်ဆင်မှု

- Workspace ကို ဖြေရှင်း၍ ဖန်တီးသည်; sandboxed runs များတွင် sandbox workspace root သို့ redirect လုပ်နိုင်သည်။
- Skills များကို တင်ထားသည် (သို့မဟုတ် snapshot မှ ပြန်လည်အသုံးပြုသည်) နှင့် env နှင့် prompt ထဲသို့ ထည့်သွင်းသည်။
- Bootstrap/context ဖိုင်များကို ဖြေရှင်းပြီး system prompt report ထဲသို့ ထည့်သွင်းသည်။
- Session write lock ကို ရယူပြီး streaming မစတင်မီ `SessionManager` ကို ဖွင့်ကာ ပြင်ဆင်ထားသည်။

## Prompt စုစည်းမှု + system prompt

- System prompt ကို OpenClaw ၏ base prompt၊ skills prompt၊ bootstrap context နှင့် per-run overrides များမှ စုစည်းတည်ဆောက်သည်။
- Model အလိုက် ကန့်သတ်ချက်များနှင့် compaction reserve tokens များကို အကောင်အထည်ဖော်သည်။
- Model မြင်ရသောအရာများအတွက် [System prompt](/concepts/system-prompt) ကို ကြည့်ပါ။

## Hook points (ကြားဖြတ်နိုင်သော နေရာများ)

OpenClaw တွင် hook စနစ် နှစ်မျိုး ရှိသည်။

- **Internal hooks** (Gateway hooks): command နှင့် lifecycle ဖြစ်ရပ်များအတွက် event-driven scripts များ။
- **Plugin hooks**: agent/tool lifecycle နှင့် gateway pipeline အတွင်းရှိ extension points များ။

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: system prompt ကို အပြီးသတ် မချမှတ်မီ bootstrap ဖိုင်များကို တည်ဆောက်နေစဉ် run လုပ်ပါသည်။
  Bootstrap context ဖိုင်များကို ထည့်ရန်/ဖယ်ရှားရန် ဒီကို အသုံးပြုပါ။
- **Command hooks**: `/new`, `/reset`, `/stop`, နှင့် အခြား command ဖြစ်ရပ်များ (Hooks doc ကို ကြည့်ပါ)။

တပ်ဆင်နည်းနှင့် ဥပမာများအတွက် [Hooks](/automation/hooks) ကို ကြည့်ပါ။

### Plugin hooks (agent + gateway lifecycle)

ဤ hook များသည် agent loop သို့မဟုတ် gateway pipeline အတွင်းတွင် လည်ပတ်သည်။

- **`before_agent_start`**: run မစတင်မီ context ထည့်သွင်းခြင်း သို့မဟုတ် system prompt ကို override လုပ်ခြင်း။
- **`agent_end`**: ပြီးဆုံးပြီးနောက် နောက်ဆုံး message စာရင်းနှင့် run metadata ကို စစ်ဆေးခြင်း။
- **`before_compaction` / `after_compaction`**: compaction cycles များကို ကြည့်ရှုခြင်း သို့မဟုတ် မှတ်ချက်ထည့်ခြင်း။
- **`before_tool_call` / `after_tool_call`**: tool params/results ကို ကြားဖြတ်ခြင်း။
- **`tool_result_persist`**: session transcript သို့ မရေးမီ tool results ကို synchronous အဖြစ် ပြောင်းလဲခြင်း။
- **`message_received` / `message_sending` / `message_sent`**: inbound + outbound message hooks များ။
- **`session_start` / `session_end`**: session lifecycle အစွန်းအထင်းများ။
- **`gateway_start` / `gateway_stop`**: Gateway（ဂိတ်ဝေး） lifecycle ဖြစ်ရပ်များ။

Hook API နှင့် မှတ်ပုံတင်အသေးစိတ်အတွက် [Plugins](/tools/plugin#plugin-hooks) ကို ကြည့်ပါ။

## Streaming + အစိတ်အပိုင်းပြန်ကြားချက်များ

- Assistant deltas များကို pi-agent-core မှ စီးကြောင်းဖြင့် ပို့ပြီး `assistant` ဖြစ်ရပ်များအဖြစ် ထုတ်လွှင့်သည်။
- Block streaming သည် `text_end` သို့မဟုတ် `message_end` ပေါ်တွင် အစိတ်အပိုင်းပြန်ကြားချက်များကို ထုတ်လွှင့်နိုင်သည်။
- Reasoning streaming ကို သီးခြား စီးကြောင်းအဖြစ် သို့မဟုတ် block replies အဖြစ် ထုတ်လွှင့်နိုင်သည်။
- Chunking နှင့် block reply အပြုအမူများအတွက် [Streaming](/concepts/streaming) ကို ကြည့်ပါ။

## Tool အကောင်အထည်ဖော်ခြင်း + messaging tools

- Tool start/update/end ဖြစ်ရပ်များကို `tool` စီးကြောင်းပေါ်တွင် ထုတ်လွှင့်သည်။
- Tool results များကို logging/ထုတ်လွှင့်မီ အရွယ်အစားနှင့် ပုံရိပ် payload များအတွက် sanitize လုပ်သည်။
- Messaging tool ပို့ခြင်းများကို duplicate assistant အတည်ပြုချက်များ မထွက်လာစေရန် track လုပ်ထားသည်။

## Reply shaping + suppression

- နောက်ဆုံး payload များကို အောက်ပါအရာများမှ စုစည်းထားသည်။
  - assistant စာသား (နှင့် optional reasoning)
  - inline tool summaries (verbose + ခွင့်ပြုထားသောအခါ)
  - model error ဖြစ်ပါက assistant error စာသား
- `NO_REPLY` ကို silent token အဖြစ် သတ်မှတ်ပြီး အပြင်သို့ ထုတ်ပို့မည့် payload များမှ စစ်ထုတ်ထားသည်။
- Messaging tool duplicates များကို နောက်ဆုံး payload စာရင်းမှ ဖယ်ရှားသည်။
- Render လုပ်နိုင်သော payload မရှိတော့ဘဲ tool error ဖြစ်ပါက fallback tool error reply ကို ထုတ်လွှင့်သည်
  (messaging tool မှ အသုံးပြုသူမြင်နိုင်သော reply ကို ပို့ပြီးသား မဟုတ်ပါက)။

## Compaction + retries

- Auto-compaction သည် `compaction` စီးကြောင်း ဖြစ်ရပ်များကို ထုတ်လွှင့်ပြီး retry ကို လှုံ့ဆော်နိုင်သည်။
- Retry အချိန်တွင် duplicate output မဖြစ်စေရန် in-memory buffers နှင့် tool summaries များကို reset လုပ်သည်။
- Compaction pipeline အတွက် [Compaction](/concepts/compaction) ကို ကြည့်ပါ။

## Event streams (လက်ရှိ)

- `lifecycle`: `subscribeEmbeddedPiSession` မှ ထုတ်လွှင့်သည် (နှင့် fallback အဖြစ် `agentCommand` မှ)
- `assistant`: pi-agent-core မှ streamed deltas
- `tool`: pi-agent-core မှ streamed tool events

## Chat channel ကိုင်တွယ်မှု

- Assistant deltas များကို chat `delta` မက်ဆေ့ချ်များအဖြစ် buffer လုပ်ထားသည်။
- **lifecycle end/error** တွင် chat `final` ကို ထုတ်လွှင့်သည်။

## Timeouts

- `agent.wait` default: 30s (စောင့်ဆိုင်းချိန်သာ)။ `timeoutMs` parameter သည် override လုပ်ပေးပါသည်။
- Agent runtime: `agents.defaults.timeoutSeconds` default 600s; `runEmbeddedPiAgent` abort timer တွင် အကောင်အထည်ဖော်ထားသည်။

## စောစီးစွာ အဆုံးသတ်နိုင်သော နေရာများ

- Agent timeout (abort)
- AbortSignal (cancel)
- Gateway（ဂိတ်ဝေး） disconnect သို့မဟုတ် RPC timeout
- `agent.wait` timeout (စောင့်ဆိုင်းမှုသာ၊ agent ကို မရပ်တန့်ပါ)
