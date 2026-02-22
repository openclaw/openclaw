---
summary: "မက်ဆေ့ချ် စီးဆင်းမှု၊ ဆက်ရှင်များ၊ တန်းစီခြင်း နှင့် အကြောင်းရင်းမြင်သာမှု"
read_when:
  - အဝင်မက်ဆေ့ချ်များက ဘယ်လို ပြန်ကြားချက်များ ဖြစ်လာသည်ကို ရှင်းပြရာတွင်
  - ဆက်ရှင်များ၊ တန်းစီခြင်း မုဒ်များ သို့မဟုတ် စီးဆင်းပို့ဆောင်မှု အပြုအမူများကို ရှင်းလင်းရာတွင်
  - အကြောင်းရင်းမြင်သာမှုနှင့် အသုံးပြုမှုဆိုင်ရာ သက်ရောက်မှုများကို စာရွက်တင်သည့်အခါ
title: "မက်ဆေ့ချ်များ"
---

# မက်ဆေ့ချ်များ

ဤစာမျက်နှာသည် OpenClaw က အဝင်မက်ဆေ့ချ်များ၊ ဆက်ရှင်များ၊ တန်းစီခြင်း၊
စီးဆင်းပို့ဆောင်မှု နှင့် အကြောင်းရင်းမြင်သာမှုတို့ကို မည်သို့ ကိုင်တွယ်သည်ကို ပေါင်းစည်းရှင်းလင်းထားသည်။

## မက်ဆေ့ချ် စီးဆင်းမှု (အဆင့်မြင့် အကျဉ်းချုပ်)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

အဓိက ခလုတ်များကို ဖွဲ့စည်းပြင်ဆင်မှုတွင် တွေ့နိုင်သည်-

- ပရီးဖစ်များ၊ တန်းစီခြင်း နှင့် အုပ်စု အပြုအမူများအတွက် `messages.*`။
- ဘလောက်အလိုက် စီးဆင်းပို့ဆောင်မှု နှင့် ချန့်ခွဲခြင်း မူလတန်ဖိုးများအတွက် `agents.defaults.*`။
- Channel overrides (`channels.whatsapp.*`, `channels.telegram.*`, etc.) for caps and streaming toggles.

အပြည့်အစုံ စနစ်ဖွဲ့စည်းပုံအတွက် [Configuration](/gateway/configuration) ကို ကြည့်ပါ။

## အဝင် မက်ဆေ့ချ် ထပ်တူဖယ်ရှားခြင်း (Inbound dedupe)

Channels can redeliver the same message after reconnects. OpenClaw keeps a
short-lived cache keyed by channel/account/peer/session/message id so duplicate
deliveries do not trigger another agent run.

## အဝင် မက်ဆေ့ချ် တုန့်ပြန်နှေးကွေးပေါင်းစည်းခြင်း (Inbound debouncing)

Rapid consecutive messages from the **same sender** can be batched into a single
agent turn via `messages.inbound`. Debouncing is scoped per channel + conversation
and uses the most recent message for reply threading/IDs.

ဖွဲ့စည်းပြင်ဆင်မှု (ကမ္ဘာလုံးဆိုင်ရာ မူလတန်ဖိုး + ချန်နယ်အလိုက် အစားထိုးများ):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

မှတ်ချက်များ-

- Debounce သည် **စာသားသာ** မက်ဆေ့ချ်များအတွက်သာ သက်ရောက်သည်; မီဒီယာ/အတူတွဲဖိုင်များသည် ချက်ချင်း လွှတ်ထုတ်သည်။
- ထိန်းချုပ်မှု အမိန့်များသည် Debouncing ကို ကျော်လွှားပြီး တစ်ခုချင်းစီ သီးသန့် ရှိနေစေသည်။

## ဆက်ရှင်များ နှင့် ကိရိယာများ

ဆက်ရှင်များကို client များမဟုတ်ဘဲ Gateway က ပိုင်ဆိုင်သည်။

- တိုက်ရိုက် စကားပြောများသည် အေးဂျင့် အဓိက ဆက်ရှင် ကီးသို့ ပေါင်းစည်းသည်။
- အုပ်စုများ/ချန်နယ်များတွင် ကိုယ်ပိုင် ဆက်ရှင် ကီးများ ရှိသည်။
- ဆက်ရှင် သိုလှောင်ရာ နှင့် စာတမ်းမှတ်တမ်းများသည် Gateway ဟို့စ် ပေါ်တွင် ရှိသည်။

Multiple devices/channels can map to the same session, but history is not fully
synced back to every client. Recommendation: use one primary device for long
conversations to avoid divergent context. The Control UI and TUI always show the
gateway-backed session transcript, so they are the source of truth.

အသေးစိတ်: [Session management](/concepts/session)။

## အဝင် ဘော်ဒီများ နှင့် သမိုင်းအကြောင်းအရာ

OpenClaw သည် **prompt body** နှင့် **command body** ကို ခွဲခြားထားသည်-

- `Body`: prompt text sent to the agent. This may include channel envelopes and
  optional history wrappers.
- `CommandBody`: လမ်းညွှန်ချက်/အမိန့် ခွဲခြမ်းစိတ်ဖြာရန် အသုံးပြုသော အသုံးပြုသူ၏ မူရင်း စာသား။
- `RawBody`: `CommandBody` အတွက် အဟောင်း alias (ကိုက်ညီမှုအတွက် ထားရှိထားသည်)။

ချန်နယ်တစ်ခုက သမိုင်းကို ပံ့ပိုးပါက မျှဝေထားသော အဖုံးတစ်ခုကို အသုံးပြုသည်-

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For **non-direct chats** (groups/channels/rooms), the **current message body** is prefixed with the
sender label (same style used for history entries). This keeps real-time and queued/history
messages consistent in the agent prompt.

သမိုင်း ဘဖာများသည် **စောင့်ဆိုင်းနေသည့် အချက်များသာ** ပါဝင်သည်- အလုပ်မလုပ်စေခဲ့သော အုပ်စု မက်ဆေ့ချ်များ (ဥပမာ၊ mention-gated မက်ဆေ့ချ်များ) ကို ထည့်သွင်းပြီး ဆက်ရှင် စာတမ်းမှတ်တမ်းထဲတွင် ရှိပြီးသား မက်ဆေ့ချ်များကို **မပါဝင်** စေပါ။

Directive stripping only applies to the **current message** section so history
remains intact. Channels that wrap history should set `CommandBody` (or
`RawBody`) to the original message text and keep `Body` as the combined prompt.
History buffers are configurable via `messages.groupChat.historyLimit` (global
default) and per-channel overrides like `channels.slack.historyLimit` or
`channels.telegram.accounts.<id>.historyLimit` (set `0` to disable).

## တန်းစီခြင်း နှင့် နောက်ဆက်တွဲများ

အလုပ်လုပ်နေသော run တစ်ခု ရှိပြီးသားဖြစ်ပါက အဝင် မက်ဆေ့ချ်များကို တန်းစီနိုင်ပြီး လက်ရှိ run သို့ ဦးတည်စေနိုင်သကဲ့သို့
နောက်တစ်လှည့် အတွက် စုဆောင်းထားနိုင်ပါသည်။

- `messages.queue` (နှင့် `messages.queue.byChannel`) ဖြင့် ဖွဲ့စည်းပါ။
- မုဒ်များ: `interrupt`, `steer`, `followup`, `collect`, နှင့် backlog မျိုးကွဲများ။

အသေးစိတ်: [Queueing](/concepts/queue)။

## စီးဆင်းပို့ဆောင်မှု၊ ချန့်ခွဲခြင်း နှင့် အစုလိုက်ပို့ခြင်း

Block streaming sends partial replies as the model produces text blocks.
Chunking respects channel text limits and avoids splitting fenced code.

အဓိက သတ်မှတ်ချက်များ-

- `agents.defaults.blockStreamingDefault` (`on|off`, မူလအနေဖြင့် ပိတ်)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (အလုပ်မရှိချိန် အခြေပြု အစုလိုက်ပို့ခြင်း)
- `agents.defaults.humanDelay` (လူသားဆန်သည့် ဘလောက်ပြန်ကြားချက်များကြား ခဏနား)
- ချန်နယ် အစားထိုးများ: `*.blockStreaming` နှင့် `*.blockStreamingCoalesce` (Telegram မဟုတ်သော ချန်နယ်များတွင် အထူး `*.blockStreaming: true` ကို လိုအပ်သည်)

အသေးစိတ်: [Streaming + chunking](/concepts/streaming)။

## အကြောင်းရင်း မြင်သာမှု နှင့် တိုကင်များ

OpenClaw သည် မော်ဒယ် အကြောင်းရင်းကို ဖော်ပြနိုင်သလို ဖုံးကွယ်နိုင်ပါသည်-

- `/reasoning on|off|stream` သည် မြင်သာမှုကို ထိန်းချုပ်သည်။
- မော်ဒယ်က ထုတ်လုပ်ပါက အကြောင်းရင်း အကြောင်းအရာသည် တိုကင် အသုံးပြုမှုထဲတွင် ထည့်တွက်ထားဆဲ ဖြစ်သည်။
- Telegram သည် draft bubble ထဲသို့ အကြောင်းရင်း စီးဆင်းမှုကို ထောက်ပံ့သည်။

အသေးစိတ်: [Thinking + reasoning directives](/tools/thinking) နှင့် [Token use](/reference/token-use)။

## ပရီးဖစ်များ၊ ချည်တွဲခြင်း နှင့် ပြန်ကြားချက်များ

အထွက် မက်ဆေ့ချ် ပုံစံချခြင်းကို `messages` တွင် အလယ်တန်း စီမံထားသည်-

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, and `channels.<channel>.accounts.<id>.responsePrefix` (outbound prefix cascade), plus `channels.whatsapp.messagePrefix` (WhatsApp inbound prefix)
- `replyToMode` နှင့် ချန်နယ်အလိုက် မူလတန်ဖိုးများဖြင့် ပြန်ကြားချက် ချည်တွဲခြင်း

အသေးစိတ်: [Configuration](/gateway/configuration#messages) နှင့် ချန်နယ် စာရွက်များ။
