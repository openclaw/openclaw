---
summary: "نظرة عامة على بوت Feishu، الميزات، والتهيئة"
read_when:
  - تريد ربط بوت Feishu/Lark
  - تقوم بتهيئة قناة Feishu
title: Feishu
---

# بوت Feishu

Feishu ‏(Lark) هي منصة دردشة فرق تستخدمها الشركات للمراسلة والتعاون. يقوم هذا الملحق بربط OpenClaw ببوت Feishu/Lark باستخدام اشتراك الأحداث عبر WebSocket الخاص بالمنصة، بحيث يمكن استقبال الرسائل دون الحاجة إلى تعريض عنوان webhook عام.

---

## الملحق المطلوب

قم بتثبيت ملحق Feishu:

```bash
openclaw plugins install @openclaw/feishu
```

الاستنساخ المحلي (عند التشغيل من مستودع git):

```bash
openclaw plugins install ./extensions/feishu
```

---

## البدء السريع

هناك طريقتان لإضافة قناة Feishu:

### الطريقة 1: معالج التهيئة الأولية (موصى بها)

إذا كنت قد ثبّت OpenClaw للتو، شغّل المعالج:

```bash
openclaw onboard
```

يقودك المعالج عبر:

1. إنشاء تطبيق Feishu وجمع بيانات الاعتماد
2. تهيئة بيانات اعتماد التطبيق في OpenClaw
3. تشغيل Gateway

✅ **بعد التهيئة**، تحقّق من حالة Gateway:

- `openclaw gateway status`
- `openclaw logs --follow`

### الطريقة 2: الإعداد عبر CLI

إذا كنت قد أكملت التثبيت الأولي بالفعل، أضف القناة عبر CLI:

```bash
openclaw channels add
```

اختر **Feishu**، ثم أدخل App ID وApp Secret.

✅ **بعد التهيئة**، أدر Gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## الخطوة 1: إنشاء تطبيق Feishu

### 1. فتح منصة Feishu Open Platform

انتقل إلى [Feishu Open Platform](https://open.feishu.cn/app) وسجّل الدخول.

يجب على مستأجري Lark ‏(العالميين) استخدام [https://open.larksuite.com/app](https://open.larksuite.com/app) وضبط `domain: "lark"` في تهيئة Feishu.

### 2. إنشاء تطبيق

1. انقر على **Create enterprise app**
2. أدخل اسم التطبيق + الوصف
3. اختر أيقونة للتطبيق

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. نسخ بيانات الاعتماد

من **Credentials & Basic Info**، انسخ:

- **App ID** (الصيغة: `cli_xxx`)
- **App Secret**

❗ **مهم:** احفظ App Secret بسرية.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. تهيئة الأذونات

في **Permissions**، انقر على **Batch import** والصق:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. تفعيل قدرة البوت

في **App Capability** > **Bot**:

1. فعّل قدرة البوت
2. عيّن اسم البوت

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. تهيئة الاشتراك بالأحداث

⚠️ **مهم:** قبل إعداد الاشتراك بالأحداث، تأكد من:

1. أنك قد شغّلت بالفعل `openclaw channels add` لـ Feishu
2. أن Gateway يعمل (`openclaw gateway status`)

في **Event Subscription**:

1. اختر **Use long connection to receive events** ‏(WebSocket)
2. أضف الحدث: `im.message.receive_v1`

⚠️ إذا لم يكن Gateway يعمل، فقد يفشل حفظ إعداد الاتصال طويل الأمد.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. نشر التطبيق

1. أنشئ إصدارًا في **Version Management & Release**
2. قدّمه للمراجعة وانشره
3. انتظر موافقة المسؤول (عادةً ما تتم الموافقة تلقائيًا على تطبيقات المؤسسات)

---

## الخطوة 2: تهيئة OpenClaw

### التهيئة باستخدام المعالج (موصى بها)

```bash
openclaw channels add
```

اختر **Feishu** والصق App ID وApp Secret.

### التهيئة عبر ملف التهيئة

حرّر `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### التهيئة عبر متغيرات البيئة

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### نطاق Lark ‏(العالمي)

إذا كان المستأجر لديك على Lark ‏(الدولي)، فاضبط النطاق إلى `lark` (أو سلسلة نطاق كاملة). يمكنك ضبطه في `channels.feishu.domain` أو لكل حساب (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## الخطوة 3: التشغيل + الاختبار

### 1. تشغيل Gateway

```bash
openclaw gateway
```

### 2. إرسال رسالة اختبار

في Feishu، اعثر على البوت وأرسل رسالة.

### 3. الموافقة على الاقتران

افتراضيًا، يرد البوت برمز اقتران. وافق عليه:

```bash
openclaw pairing approve feishu <CODE>
```

بعد الموافقة، يمكنك الدردشة بشكل طبيعي.

---

## نظرة عامة

- **قناة بوت Feishu**: بوت Feishu تتم إدارته بواسطة Gateway
- **توجيه حتمي**: تعود الردود دائمًا إلى Feishu
- **عزل الجلسات**: الرسائل المباشرة تشترك في جلسة رئيسية؛ المجموعات معزولة
- **اتصال WebSocket**: اتصال طويل عبر Feishu SDK، دون الحاجة إلى عنوان URL عام

---

## التحكم في الوصول

### الرسائل المباشرة

- **الافتراضي**: `dmPolicy: "pairing"` (يحصل المستخدمون غير المعروفين على رمز اقتران)

- **الموافقة على الاقتران**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **وضع قائمة السماح**: عيّن `channels.feishu.allowFrom` مع Open IDs المسموح بها

### الدردشات الجماعية

**1. سياسة المجموعات** (`channels.feishu.groupPolicy`):

- `"open"` = السماح للجميع في المجموعات (افتراضي)
- `"allowlist"` = السماح فقط لـ `groupAllowFrom`
- `"disabled"` = تعطيل رسائل المجموعات

**2. شرط الإشارة** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = يتطلب @mention (افتراضي)
- `false` = الرد دون إشارات

---

## أمثلة تهيئة المجموعات

### السماح بجميع المجموعات، مع اشتراط @mention (افتراضي)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### السماح بجميع المجموعات، دون اشتراط @mention

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### السماح لمستخدمين محددين في المجموعات فقط

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## الحصول على معرّفات المجموعات/المستخدمين

### معرّفات المجموعات (chat_id)

تبدو معرّفات المجموعات مثل `oc_xxx`.

**الطريقة 1 (موصى بها)**

1. شغّل Gateway وقم بعمل @mention للبوت في المجموعة
2. شغّل `openclaw logs --follow` وابحث عن `chat_id`

**الطريقة 2**

استخدم أداة تصحيح أخطاء واجهة Feishu API لسرد دردشات المجموعات.

### معرّفات المستخدمين (open_id)

تبدو معرّفات المستخدمين مثل `ou_xxx`.

**الطريقة 1 (موصى بها)**

1. بدء تشغيل البوابة و DM البوت
2. شغّل `openclaw logs --follow` وابحث عن `open_id`

**الطريقة 2**

تحقّق من طلبات الاقتران لمعرفة Open IDs الخاصة بالمستخدمين:

```bash
openclaw pairing list feishu
```

---

## الأوامر الشائعة

| الأمر     | الوصف              |
| --------- | ------------------ |
| `/status` | عرض حالة البوت     |
| `/reset`  | إعادة تعيين الجلسة |
| `/model`  | عرض/تبديل النموذج  |

> ملاحظة: لا يدعم Feishu حتى الآن قوائم الأوامر الأصلية، لذا يجب إرسال الأوامر كنص.

## أوامر إدارة Gateway

| الأمر                      | الوصف                    |
| -------------------------- | ------------------------ |
| `openclaw gateway status`  | عرض حالة Gateway         |
| `openclaw gateway install` | تثبيت/تشغيل خدمة Gateway |
| `openclaw gateway stop`    | إيقاف خدمة Gateway       |
| `openclaw gateway restart` | إعادة تشغيل خدمة Gateway |
| `openclaw logs --follow`   | تتبّع سجلات Gateway      |

---

## استكشاف الأخطاء وإصلاحها

### البوت لا يستجيب في الدردشات الجماعية

1. تأكد من إضافة البوت إلى المجموعة
2. تأكد من عمل @mention للبوت (السلوك الافتراضي)
3. تحقّق من أن `groupPolicy` غير مضبوط على `"disabled"`
4. تحقّق من السجلات: `openclaw logs --follow`

### البوت لا يستقبل الرسائل

1. تأكد من نشر التطبيق والموافقة عليه
2. تأكد من أن اشتراك الأحداث يتضمن `im.message.receive_v1`
3. تأكد من تفعيل **الاتصال طويل الأمد**
4. تأكد من اكتمال أذونات التطبيق
5. تأكد من أن Gateway يعمل: `openclaw gateway status`
6. تحقّق من السجلات: `openclaw logs --follow`

### تسريب App Secret

1. أعد تعيين App Secret في Feishu Open Platform
2. حدّث App Secret في التهيئة
3. أعد تشغيل Gateway

### فشل إرسال الرسائل

1. تأكد من أن التطبيق يمتلك إذن `im:message:send_as_bot`
2. تأكد من نشر التطبيق
3. تحقّق من السجلات لمعرفة الأخطاء التفصيلية

---

## التهيئة المتقدمة

### حسابات متعددة

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### حدود الرسائل

- `textChunkLimit`: حجم مقطع النص الصادر (الافتراضي: 2000 حرف)
- `mediaMaxMb`: حد رفع/تنزيل الوسائط (الافتراضي: 30MB)

### البث

يدعم Feishu الردود المتدفقة عبر بطاقات تفاعلية. عند التفعيل، يقوم البوت بتحديث البطاقة أثناء توليد النص.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

عيّن `streaming: false` للانتظار حتى اكتمال الرد الكامل قبل الإرسال.

### توجيه متعدد الوكلاء

استخدم `bindings` لتوجيه الرسائل المباشرة أو المجموعات في Feishu إلى وكلاء مختلفين.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

حقول التوجيه:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` أو `"group"`
- `match.peer.id`: Open ID للمستخدم (`ou_xxx`) أو معرّف المجموعة (`oc_xxx`)

انظر [الحصول على معرّفات المجموعات/المستخدمين](#get-groupuser-ids) لنصائح البحث.

---

## مرجع التهيئة

التهيئة الكاملة: [تهيئة Gateway](/gateway/configuration)

الخيارات الرئيسية:

| الإعداد                                           | الوصف                                                                                 | الافتراضي |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- | --------- |
| `channels.feishu.enabled`                         | تفعيل/تعطيل القناة                                                                    | `true`    |
| `channels.feishu.domain`                          | نطاق API ‏(`feishu` أو `lark`)                                     | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                                                                | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                                                            | -         |
| `channels.feishu.accounts.<id>.domain`            | تجاوز نطاق API لكل حساب                                                               | `feishu`  |
| `channels.feishu.dmPolicy`                        | سياسة DM                                                                              | `pairing` |
| `channels.feishu.allowFrom`                       | قائمة السماح للرسائل المباشرة (قائمة open_id) | -         |
| `channels.feishu.groupPolicy`                     | سياسة المجموعات                                                                       | `open`    |
| `channels.feishu.groupAllowFrom`                  | قائمة السماح للمجموعات                                                                | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | اشتراط @mention                                                          | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | تفعيل المجموعات                                                                       | `true`    |
| `channels.feishu.textChunkLimit`                  | حجم مقطع الرسالة                                                                      | `2000`    |
| `channels.feishu.mediaMaxMb`                      | حد حجم الوسائط                                                                        | `30`      |
| `channels.feishu.streaming`                       | تفعيل إخراج البطاقات المتدفقة                                                         | `true`    |
| `channels.feishu.blockStreaming`                  | تفعيل بثّ الكتل                                                                       | `true`    |

---

## مرجع dmPolicy

| القيمة        | السلوك                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| `"pairing"`   | **الافتراضي.** يحصل المستخدمون غير المعروفين على رمز اقتران؛ يجب الموافقة |
| `"allowlist"` | يمكن فقط للمستخدمين الموجودين في `allowFrom` الدردشة                                      |
| `"open"`      | السماح لجميع المستخدمين (يتطلب `"*"` في allowFrom)                     |
| `"disabled"`  | تعطيل DMs                                                                                 |

---

## أنواع الرسائل المدعومة

### الاستقبال

- ✅ نص
- ✅ نص منسّق (post)
- ✅ صور
- ✅ ملفات
- ✅ صوت
- ✅ فيديو
- ✅ ملصقات

### الإرسال

- ✅ نص
- ✅ صور
- ✅ ملفات
- ✅ صوت
- ⚠️ نص منسّق (دعم جزئي)
