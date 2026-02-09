---
summary: "قواعد التوجيه لكل قناة (WhatsApp وTelegram وDiscord وSlack) والسياق المشترك"
read_when:
  - عند تغيير توجيه القنوات أو سلوك صندوق الوارد
title: "توجيه القنوات"
---

# القنوات والتوجيه

يقوم OpenClaw بتوجيه الردود **مرة أخرى إلى القناة التي جاء منها message**. لا يختار النموذج قناةً؛ فالتوجيه حتميّ ويتم التحكم فيه بواسطة تهيئة المضيف.

## المصطلحات الأساسية

- **Channel**: `whatsapp`، `telegram`، `discord`، `slack`، `signal`، `imessage`، `webchat`.
- **AccountId**: مثيل حساب لكل قناة (عند الدعم).
- **AgentId**: مساحة عمل معزولة + مخزن جلسات («العقل»).
- **SessionKey**: مفتاح الحاوية المستخدم لتخزين السياق والتحكم في التزامن.

## أشكال مفاتيح الجلسة (أمثلة)

تندمج الرسائل المباشرة في جلسة الوكيل **الرئيسية**:

- `agent:<agentId>:<mainKey>` (الافتراضي: `agent:main:main`)

تبقى المجموعات والقنوات معزولة لكل قناة:

- المجموعات: `agent:<agentId>:<channel>:group:<id>`
- القنوات/الغرف: `agent:<agentId>:<channel>:channel:<id>`

المواضيع (Threads):

- تضيف مواضيع Slack/Discord `:thread:<threadId>` إلى المفتاح الأساسي.
- تُضمِّن موضوعات منتديات Telegram `:topic:<topicId>` ضمن مفتاح المجموعة.

أمثلة:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## قواعد التوجيه (كيفية اختيار الوكيل)

يختار التوجيه **وكيلاً واحدًا** لكل رسالة واردة:

1. **مطابقة النظير الدقيقة** (`bindings` مع `peer.kind` + `peer.id`).
2. **مطابقة النقابة** (Discord) عبر `guildId`.
3. **مطابقة الفريق** (Slack) عبر `teamId`.
4. **مطابقة الحساب** (`accountId` على القناة).
5. **مطابقة القناة** (أي حساب على تلك القناة).
6. **الوكيل الافتراضي** (`agents.list[].default`، وإلا فأول إدخال في القائمة، مع الرجوع إلى `main`).

يحدد الوكيل المطابق مساحة العمل ومخزن الجلسات المستخدمين.

## مجموعات البث (تشغيل عدة وكلاء)

تتيح مجموعات البث تشغيل **عدة وكلاء** للنظير نفسه **عندما يقوم OpenClaw عادةً بالرد** (على سبيل المثال: في مجموعات WhatsApp، بعد بوابة الذكر/التفعيل).

التهيئة:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

انظر: [مجموعات البث](/channels/broadcast-groups).

## نظرة عامة على التهيئة

- `agents.list`: تعريفات الوكلاء المسماة (مساحة العمل، النموذج، إلخ).
- `bindings`: ربط القنوات/الحسابات/الأقران الواردة بالوكلاء.

مثال:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## تخزين الجلسات

توجد مخازن الجلسات ضمن دليل الحالة (الافتراضي `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- تُحفظ سجلات JSONL بجوار المخزن

يمكنك تجاوز مسار المخزن عبر قوالب `session.store` و`{agentId}`.

## سلوك WebChat

يرتبط WebChat بالوكيل **المحدد** ويستخدم افتراضيًا الجلسة الرئيسية للوكيل. وبسبب ذلك، يتيح WebChat عرض سياق عابر للقنوات لهذا الوكيل في مكان واحد.

## سياق الرد

تتضمن الردود الواردة:

- `ReplyToId` و`ReplyToBody` و`ReplyToSender` عند توفرها.
- يُلحَق السياق المُقتبَس بـ `Body` على هيئة كتلة `[Replying to ...]`.

هذا السلوك متسق عبر القنوات.
