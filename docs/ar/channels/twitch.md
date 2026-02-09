---
summary: "تهيئة وإعداد روبوت دردشة Twitch"
read_when:
  - إعداد تكامل دردشة Twitch لـ OpenClaw
title: "Twitch"
---

# Twitch (إضافة)

دعم دردشة Twitch عبر اتصال IRC. يتصل OpenClaw كمستخدم Twitch (حساب روبوت) لاستقبال الرسائل وإرسالها في القنوات.

## الإضافة المطلوبة

يأتي Twitch كإضافة ولا يكون مضمّنًا مع التثبيت الأساسي.

التثبيت عبر CLI (سجل npm):

```bash
openclaw plugins install @openclaw/twitch
```

التحقق المحلي (عند التشغيل من مستودع git):

```bash
openclaw plugins install ./extensions/twitch
```

التفاصيل: [Plugins](/tools/plugin)

## الإعداد السريع (للمبتدئين)

1. أنشئ حساب Twitch مخصصًا للروبوت (أو استخدم حسابًا موجودًا).
2. أنشئ بيانات الاعتماد: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - اختر **Bot Token**
   - تأكّد من تحديد النطاقين `chat:read` و `chat:write`
   - انسخ **Client ID** و **Access Token**
3. اعثر على معرّف مستخدم Twitch الخاص بك: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. تكوين الرمز المميز:
   - متغير بيئة: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (للحساب الافتراضي فقط)
   - أو عبر التهيئة: `channels.twitch.accessToken`
   - إذا تم تعيين الاثنين، تكون الأولوية للتهيئة (ويكون الرجوع لمتغير البيئة للحساب الافتراضي فقط).
5. ابدأ الـ Gateway.

**⚠️ مهم:** أضِف ضبط الوصول (`allowFrom` أو `allowedRoles`) لمنع المستخدمين غير المصرّح لهم من تفعيل الروبوت. القيمة الافتراضية لـ `requireMention` هي `true`.

تهيئة دنيا:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## ما هو

- قناة Twitch مملوكة لـ Gateway.
- توجيه حتمي: تعود الردود دائمًا إلى Twitch.
- يَرتبط كل حساب بمفتاح جلسة معزول `agent:<agentId>:twitch:<accountName>`.
- `username` هو حساب الروبوت (الذي يقوم بالمصادقة)، و `channel` هو غرفة الدردشة التي يتم الانضمام إليها.

## الإعداد (بالتفصيل)

### إنشاء بيانات الاعتماد

استخدم [Twitch Token Generator](https://twitchtokengenerator.com/):

- اختر **Bot Token**
- تأكّد من تحديد النطاقين `chat:read` و `chat:write`
- انسخ **Client ID** و **Access Token**

لا يلزم تسجيل تطبيق يدويًا. تنتهي صلاحية الرموز بعد عدة ساعات.

### تهيئة الروبوت

**متغير بيئة (للحساب الافتراضي فقط):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**أو عبر التهيئة:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

إذا تم تعيين متغير البيئة والتهيئة معًا، تكون الأولوية للتهيئة.

### ضبط الوصول (موصى به)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

يُفضَّل `allowFrom` لقائمة سماح صارمة. استخدم `allowedRoles` بدلًا من ذلك إذا رغبت في وصول قائم على الأدوار.

**الأدوار المتاحة:** `"moderator"`، `"owner"`، `"vip"`، `"subscriber"`، `"all"`.

**لماذا معرّفات المستخدمين؟** يمكن تغيير أسماء المستخدمين، ما يسمح بانتحال الهوية. معرّفات المستخدمين دائمة.

اعثر على معرّف مستخدم Twitch الخاص بك: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (تحويل اسم مستخدم Twitch إلى معرّف)

## تحديث الرمز (اختياري)

لا يمكن تحديث الرموز من [Twitch Token Generator](https://twitchtokengenerator.com/) تلقائيًا — أعد إنشاء الرمز عند انتهاء صلاحيته.

للتحديث التلقائي للرمز، أنشئ تطبيق Twitch خاصًا بك في [Twitch Developer Console](https://dev.twitch.tv/console) وأضِفه إلى التهيئة:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

يقوم الروبوت بتحديث الرموز تلقائيًا قبل انتهاء الصلاحية ويسجّل أحداث التحديث.

## دعم تعدد الحسابات

استخدم `channels.twitch.accounts` مع رموز لكل حساب. راجع [`gateway/configuration`](/gateway/configuration) للنمط المشترك.

مثال (حساب روبوت واحد في قناتين):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**ملاحظة:** يحتاج كل حساب إلى رمزه الخاص (رمز واحد لكل قناة).

## ضبط الوصول

### القيود القائمة على الأدوار

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### قائمة سماح حسب معرّف المستخدم (الأكثر أمانًا)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### وصول قائم على الأدوار (بديل)

`allowFrom` هي قائمة سماح صارمة. عند تعيينها، يُسمح فقط لمعرّفات المستخدمين المذكورة.
إذا أردت وصولًا قائمًا على الأدوار، اترك `allowFrom` غير معيّن وهيّئ `allowedRoles` بدلًا من ذلك:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### تعطيل شرط الإشارة @mention

افتراضيًا، تكون قيمة `requireMention` هي `true`. لتعطيله والرد على جميع الرسائل:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## استكشاف الأخطاء وإصلاحها

أولًا، شغّل أوامر التشخيص:

```bash
openclaw doctor
openclaw channels status --probe
```

### الروبوت لا يستجيب للرسائل

**تحقق من ضبط الوصول:** تأكّد من أن معرّف المستخدم الخاص بك موجود في `allowFrom`، أو أزل مؤقتًا
`allowFrom` واضبط `allowedRoles: ["all"]` للاختبار.

**تحقق من وجود الروبوت في القناة:** يجب أن ينضم الروبوت إلى القناة المحددة في `channel`.

### مشاكل الرمز

**«Failed to connect» أو أخطاء المصادقة:**

- تحقّق من أن `accessToken` هو قيمة رمز الوصول OAuth (عادةً يبدأ بالبادئة `oauth:`)
- تحقّق من أن الرمز يحتوي على النطاقين `chat:read` و `chat:write`
- إذا كنت تستخدم تحديث الرمز، تحقّق من تعيين `clientSecret` و `refreshToken`

### تحديث الرمز المميز لا يعمل

**تحقّق من السجلات لأحداث التحديث:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

إذا رأيت «token refresh disabled (no refresh token)»:

- تأكّد من توفير `clientSecret`
- تأكّد من توفير `refreshToken`

## التهيئة

**تهيئة الحساب:**

- `username` - اسم مستخدم الروبوت
- `accessToken` - رمز وصول OAuth مع `chat:read` و `chat:write`
- `clientId` - معرّف عميل Twitch (من Token Generator أو من تطبيقك)
- `channel` - القناة التي سيتم الانضمام إليها (مطلوب)
- `enabled` - تمكين هذا الحساب (الافتراضي: `true`)
- `clientSecret` - اختياري: للتحديث التلقائي للرمز
- `refreshToken` - اختياري: للتحديث التلقائي للرمز
- `expiresIn` - مدة صلاحية الرمز بالثواني
- `obtainmentTimestamp` - طابع زمني للحصول على الرمز
- `allowFrom` - قائمة سماح بمعرّفات المستخدمين
- `allowedRoles` - ضبط وصول قائم على الأدوار (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - اشتراط @mention (الافتراضي: `true`)

**خيارات الموفّر:**

- `channels.twitch.enabled` - تمكين/تعطيل بدء القناة
- `channels.twitch.username` - اسم مستخدم الروبوت (تهيئة مبسّطة لحساب واحد)
- `channels.twitch.accessToken` - رمز وصول OAuth (تهيئة مبسّطة لحساب واحد)
- `channels.twitch.clientId` - معرّف عميل Twitch (تهيئة مبسّطة لحساب واحد)
- `channels.twitch.channel` - القناة التي سيتم الانضمام إليها (تهيئة مبسّطة لحساب واحد)
- `channels.twitch.accounts.<accountName>` - تهيئة متعددة الحسابات (جميع حقول الحساب أعلاه)

مثال كامل:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## إجراءات الأداة

يمكن للوكيل استدعاء `twitch` بالإجراء:

- `send` - إرسال رسالة إلى قناة

مثال:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## السلامة والتشغيل

- **عامِل الرموز ككلمات مرور** — لا تُدرِج الرموز في git مطلقًا
- **استخدم التحديث التلقائي للرمز** للروبوتات طويلة التشغيل
- **استخدم قوائم السماح بمعرّفات المستخدمين** بدلًا من أسماء المستخدمين لضبط الوصول
- **راقب السجلات** لأحداث تحديث الرمز وحالة الاتصال
- **قلّل نطاقات الرموز** — اطلب فقط `chat:read` و `chat:write`
- **إذا تعذّر الحل**: أعد تشغيل الـ Gateway بعد التأكد من عدم امتلاك أي عملية أخرى للجلسة

## الحدود

- **500 حرف** لكل رسالة (تجزئة تلقائية عند حدود الكلمات)
- تتم إزالة Markdown قبل التجزئة
- لا يوجد تحديد لمعدل الإرسال (يستخدم حدود Twitch المدمجة)
