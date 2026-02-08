---
summary: "معمارية Gateway عبر WebSocket، المكوّنات، وتدفّقات العملاء"
read_when:
  - عند العمل على بروتوكول Gateway أو العملاء أو وسائل النقل
title: "معمارية Gateway"
x-i18n:
  source_path: concepts/architecture.md
  source_hash: 14079136faa267d7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:16Z
---

# معمارية Gateway

آخر تحديث: 2026-01-22

## نظرة عامة

- **Gateway** واحد طويل العمر يمتلك جميع أسطح المراسلة (WhatsApp عبر
  Baileys، وTelegram عبر grammY، وSlack، وDiscord، وSignal، وiMessage، وWebChat).
- يتصل عملاء مستوى التحكّم (تطبيق macOS، وCLI، وواجهة الويب، والأتمتة) بـ
  Gateway عبر **WebSocket** على مضيف الربط المُهيّأ (الافتراضي
  `127.0.0.1:18789`).
- تتصل **العُقد** (macOS/iOS/Android/بدون واجهة) أيضًا عبر **WebSocket**، لكنها
  تعلن `role: node` مع إمكانات/أوامر صريحة.
- Gateway واحد لكل مضيف؛ وهو المكان الوحيد الذي يفتح جلسة WhatsApp.
- يخدم **مضيف اللوحة** (الافتراضي `18793`) ملفات HTML القابلة للتحرير من قِبل الوكيل وواجهة A2UI.

## المكوّنات والتدفّقات

### Gateway (خدمة)

- يدير اتصالات الموفّرين.
- يعرِض واجهة WS مُنمذجة (طلبات، ردود، أحداث دفع من الخادم).
- يتحقّق من الإطارات الواردة مقابل JSON Schema.
- يُطلق أحداثًا مثل `agent`، `chat`، `presence`، `health`، `heartbeat`، `cron`.

### العملاء (تطبيق mac / CLI / إدارة الويب)

- اتصال WS واحد لكل عميل.
- يرسلون طلبات (`health`، `status`، `send`، `agent`، `system-presence`).
- يشتركون في الأحداث (`tick`، `agent`، `presence`، `shutdown`).

### العُقد (macOS / iOS / Android / بدون واجهة)

- تتصل بـ **خادم WS نفسه** مع `role: node`.
- توفّر هوية جهاز في `connect`؛ والاقتران **مبني على الجهاز** (الدور `node`) وتُحفَظ الموافقات في مخزن اقتران الأجهزة.
- تكشف أوامر مثل `canvas.*`، `camera.*`، `screen.record`، `location.get`.

تفاصيل البروتوكول:

- [بروتوكول Gateway](/gateway/protocol)

### WebChat

- واجهة مستخدم ثابتة تستخدم واجهة Gateway WS لسجل الدردشة والإرسال.
- في الإعدادات البعيدة، تتصل عبر نفق SSH/Tailscale نفسه المستخدم من قِبل العملاء الآخرين.

## دورة حياة الاتصال (عميل واحد)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## بروتوكول الأسلاك (ملخّص)

- النقل: WebSocket، إطارات نصّية بحمولات JSON.
- الإطار الأول **يجب** أن يكون `connect`.
- بعد المصافحة:
  - الطلبات: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - الأحداث: `{type:"event", event, payload, seq?, stateVersion?}`
- إذا تم تعيين `OPENCLAW_GATEWAY_TOKEN` (أو `--token`)، فيجب أن يتطابق `connect.params.auth.token`
  وإلا يُغلَق المقبس.
- مفاتيح عدم التكرار مطلوبة للطرائق ذات الآثار الجانبية (`send`، `agent`) من أجل
  إعادة المحاولة بأمان؛ يحتفظ الخادم بذاكرة إزالة تكرار قصيرة العمر.
- يجب على العُقد تضمين `role: "node"` إضافةً إلى الإمكانات/الأوامر/الأذونات في `connect`.

## الاقتران + الثقة المحلية

- جميع عملاء WS (المشغّلون + العُقد) يضمّنون **هوية جهاز** في `connect`.
- تتطلّب مُعرّفات الأجهزة الجديدة موافقة اقتران؛ ويُصدر Gateway **رمز جهاز**
  للاتصالات اللاحقة.
- الاتصالات **المحلية** (local loopback أو عنوان tailnet الخاص بمضيف Gateway نفسه) يمكن
  اعتمادها تلقائيًا للحفاظ على سلاسة تجربة الاستخدام على المضيف نفسه.
- الاتصالات **غير المحلية** يجب أن تُوقّع nonce الخاص بـ `connect.challenge` وتتطلّب
  موافقة صريحة.
- يظل توثيق Gateway (`gateway.auth.*`) مُطبّقًا على **جميع** الاتصالات، المحلية أو
  البعيدة.

التفاصيل: [بروتوكول Gateway](/gateway/protocol)، [الاقتران](/channels/pairing)،
[الأمان](/gateway/security).

## تنميط البروتوكول وتوليد الشيفرة

- تُعرِّف مخططات TypeBox البروتوكول.
- يُولَّد JSON Schema من تلك المخططات.
- تُولَّد نماذج Swift من JSON Schema.

## الوصول البعيد

- المفضّل: Tailscale أو VPN.
- البديل: نفق SSH

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- تنطبق المصافحة نفسها + رمز التوثيق عبر النفق.
- يمكن تمكين TLS + التثبيت الاختياري لـ WS في الإعدادات البعيدة.

## لمحة تشغيلية

- البدء: `openclaw gateway` (في الواجهة الأمامية، مع تسجيل السجلات إلى stdout).
- الصحة: `health` عبر WS (ومضمّنة أيضًا في `hello-ok`).
- الإشراف: launchd/systemd لإعادة التشغيل التلقائي.

## ثوابت

- يتحكّم Gateway واحد فقط بجلسة Baileys واحدة لكل مضيف.
- المصافحة إلزامية؛ أي إطار أول غير JSON أو غير connect يُغلِق الاتصال فورًا.
- لا تُعاد الأحداث؛ يجب على العملاء التحديث عند حدوث فجوات.
