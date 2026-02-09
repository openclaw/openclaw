---
summary: "پیغام کے بہاؤ، سیشنز، قطار بندی، اور استدلال کی مرئیت"
read_when:
  - وضاحت کرتے وقت کہ اندر آنے والے پیغامات کیسے جوابات بنتے ہیں
  - سیشنز، قطار بندی کے موڈز، یا اسٹریمنگ کے رویّے کی وضاحت کرتے ہوئے
  - استدلال کی مرئیت اور استعمال کے مضمرات کی دستاویز بندی کرتے ہوئے
title: "پیغامات"
---

# پیغامات

یہ صفحہ وضاحت کرتا ہے کہ OpenClaw اندر آنے والے پیغامات، سیشنز، قطار بندی،
اسٹریمنگ، اور استدلال کی مرئیت کو کیسے سنبھالتا ہے۔

## پیغام کا بہاؤ (اعلیٰ سطح)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

اہم کنٹرولز کنفیگریشن میں موجود ہیں:

- `messages.*` سابقات، قطار بندی، اور گروپ رویّے کے لیے۔
- `agents.defaults.*` بلاک اسٹریمنگ اور چنکنگ کی طے شدہ ترتیبات کے لیے۔
- Channel overrides (`channels.whatsapp.*`, `channels.telegram.*`, etc.) for caps and streaming toggles.

مکمل اسکیما کے لیے [Configuration](/gateway/configuration) دیکھیں۔

## اندر آنے والی ڈپلی کیشن کی روک تھام

Channels can redeliver the same message after reconnects. OpenClaw keeps a
short-lived cache keyed by channel/account/peer/session/message id so duplicate
deliveries do not trigger another agent run.

## اندر آنے والی ڈی باؤنسنگ

Rapid consecutive messages from the **same sender** can be batched into a single
agent turn via `messages.inbound`. Debouncing is scoped per channel + conversation
and uses the most recent message for reply threading/IDs.

کنفیگ (عالمی طے شدہ + فی چینل اوور رائیڈز):

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

نوٹس:

- ڈی باؤنس صرف **صرف-متن** پیغامات پر لاگو ہوتی ہے؛ میڈیا/منسلکات فوراً فلش ہو جاتے ہیں۔
- کنٹرول کمانڈز ڈی باؤنسنگ کو بائی پاس کرتی ہیں تاکہ وہ الگ تھلگ رہیں۔

## سیشنز اور ڈیوائسز

سیشنز گیٹ وے کی ملکیت ہوتے ہیں، کلائنٹس کی نہیں۔

- براہِ راست چیٹس ایجنٹ کے مرکزی سیشن کلید میں ضم ہو جاتی ہیں۔
- گروپس/چینلز کو اپنی الگ سیشن کلیدیں ملتی ہیں۔
- سیشن اسٹور اور ٹرانسکرپٹس گیٹ وے ہوسٹ پر موجود ہوتے ہیں۔

Multiple devices/channels can map to the same session, but history is not fully
synced back to every client. Recommendation: use one primary device for long
conversations to avoid divergent context. The Control UI and TUI always show the
gateway-backed session transcript, so they are the source of truth.

تفصیل: [Session management](/concepts/session)۔

## اندر آنے والے باڈیز اور ہسٹری سیاق

OpenClaw **پرومپٹ باڈی** کو **کمانڈ باڈی** سے الگ کرتا ہے:

- `Body`: prompt text sent to the agent. This may include channel envelopes and
  optional history wrappers.
- `CommandBody`: ہدایات/کمانڈ پارسنگ کے لیے خام صارف متن۔
- `RawBody`: `CommandBody` کے لیے لیگیسی عرف (مطابقت کے لیے برقرار)۔

جب کوئی چینل ہسٹری فراہم کرتا ہے، تو وہ ایک مشترکہ ریپر استعمال کرتا ہے:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For **non-direct chats** (groups/channels/rooms), the **current message body** is prefixed with the
sender label (same style used for history entries). This keeps real-time and queued/history
messages consistent in the agent prompt.

ہسٹری بفرز **صرف زیرِ التوا** ہوتے ہیں: ان میں گروپ پیغامات شامل ہوتے ہیں جنہوں نے
رَن کو متحرک نہیں کیا (مثلاً، مینشن-گیٹڈ پیغامات) اور وہ پیغامات **خارج** ہوتے ہیں
جو پہلے ہی سیشن ٹرانسکرپٹ میں موجود ہوں۔

Directive stripping only applies to the **current message** section so history
remains intact. Channels that wrap history should set `CommandBody` (or
`RawBody`) to the original message text and keep `Body` as the combined prompt.
History buffers are configurable via `messages.groupChat.historyLimit` (global
default) and per-channel overrides like `channels.slack.historyLimit` or
`channels.telegram.accounts.<id>.historyLimit` (set `0` to disable).

## قطار بندی اور فالو اپس

اگر کوئی رَن پہلے سے فعال ہو، تو اندر آنے والے پیغامات کو قطار میں رکھا جا سکتا ہے،
موجودہ رَن میں سمت دی جا سکتی ہے، یا فالو اپ ٹرن کے لیے جمع کیا جا سکتا ہے۔

- `messages.queue` (اور `messages.queue.byChannel`) کے ذریعے کنفیگر کریں۔
- موڈز: `interrupt`, `steer`, `followup`, `collect`، نیز بیک لاگ ویریئنٹس۔

تفصیل: [Queueing](/concepts/queue)۔

## اسٹریمنگ، چنکنگ، اور بیچنگ

21. بلاک اسٹریمنگ ماڈل کے ٹیکسٹ بلاکس پیدا کرنے کے ساتھ جزوی جوابات بھیجتی ہے۔
    Chunking respects channel text limits and avoids splitting fenced code.

اہم ترتیبات:

- `agents.defaults.blockStreamingDefault` (`on|off`, بطورِ طے شدہ بند)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (غیرفعالی پر مبنی بیچنگ)
- `agents.defaults.humanDelay` (بلاک جوابات کے درمیان انسان نما وقفہ)
- چینل اوور رائیڈز: `*.blockStreaming` اور `*.blockStreamingCoalesce` (غیر Telegram چینلز کے لیے واضح `*.blockStreaming: true` درکار)

تفصیل: [Streaming + chunking](/concepts/streaming)۔

## استدلال کی مرئیت اور ٹوکنز

OpenClaw ماڈل کے استدلال کو ظاہر یا مخفی کر سکتا ہے:

- `/reasoning on|off|stream` مرئیت کو کنٹرول کرتا ہے۔
- استدلالی مواد، اگر ماڈل کی جانب سے پیدا ہو، تو ٹوکن استعمال میں شمار ہوتا ہے۔
- Telegram ڈرافٹ ببل میں استدلالی اسٹریمنگ کی حمایت کرتا ہے۔

تفصیل: [Thinking + reasoning directives](/tools/thinking) اور [Token use](/reference/token-use)۔

## سابقات، تھریڈنگ، اور جوابات

آؤٹ باؤنڈ پیغام کی فارمیٹنگ `messages` میں مرکوز ہے:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, and `channels.<channel>.accounts.<id>.responsePrefix` (outbound prefix cascade), plus `channels.whatsapp.messagePrefix` (WhatsApp inbound prefix)
- `replyToMode` اور فی چینل طے شدہ اقدار کے ذریعے جواب کی تھریڈنگ

تفصیل: [Configuration](/gateway/configuration#messages) اور چینل دستاویزات۔
