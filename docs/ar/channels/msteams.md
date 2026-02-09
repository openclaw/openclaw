---
summary: "حالة دعم روبوت Microsoft Teams، والإمكانات، والتهيئة"
read_when:
  - العمل على ميزات قناة MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (مكوّن إضافي)

> «اتركوا كل أمل، يا من تدخلون هنا».

آخر تحديث: 2026-01-21

الحالة: يتم دعم النص + مرفقات الرسائل المباشرة؛ إرسال الملفات في القنوات/المجموعات يتطلب `sharePointSiteId` + أذونات Graph (انظر [إرسال الملفات في محادثات المجموعات](#إرسال-الملفات-في-محادثات-المجموعات)). يتم إرسال الاستطلاعات عبر بطاقات Adaptive Cards.

## المكوّن الإضافي المطلوب

يتم شحن Microsoft Teams كمكوّن إضافي ولا يأتي مضمّنًا مع التثبيت الأساسي.

**تغيير كاسر (2026.1.15):** تم إخراج MS Teams من النواة. إذا كنت تستخدمه، يجب تثبيت المكوّن الإضافي.

السبب: الحفاظ على خفة التثبيتات الأساسية والسماح بتحديث تبعيات MS Teams بشكل مستقل.

التثبيت عبر CLI (سجل npm):

```bash
openclaw plugins install @openclaw/msteams
```

التثبيت المحلي (عند التشغيل من مستودع git):

```bash
openclaw plugins install ./extensions/msteams
```

إذا اخترت Teams أثناء التهيئة/التهيئة الأولية وتم اكتشاف نسخة git محلية،
سيعرض OpenClaw مسار التثبيت المحلي تلقائيًا.

التفاصيل: [Plugins](/tools/plugin)

## إعداد سريع (للمبتدئين)

1. تثبيت مكوّن Microsoft Teams الإضافي.
2. إنشاء **Azure Bot** (معرّف التطبيق + سرّ العميل + معرّف المستأجر).
3. تهيئة OpenClaw باستخدام هذه الاعتمادات.
4. تعريض `/api/messages` (المنفذ 3978 افتراضيًا) عبر عنوان URL عام أو نفق.
5. تثبيت حزمة تطبيق Teams وبدء الـ Gateway.

تهيئة دنيا:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

ملاحظة: محادثات المجموعات محجوبة افتراضيًا (`channels.msteams.groupPolicy: "allowlist"`). للسماح بالردود في المجموعات، عيّن `channels.msteams.groupAllowFrom` (أو استخدم `groupPolicy: "open"` للسماح لأي عضو، مع اشتراط الذِكر).

## الأهداف

- التحدث إلى OpenClaw عبر الرسائل المباشرة في Teams أو محادثات المجموعات أو القنوات.
- الحفاظ على توجيه حتمي: تعود الردود دائمًا إلى القناة التي وصلت منها.
- الافتراضي هو سلوك آمن للقنوات (يتطلب الذِكر ما لم يتم الضبط خلاف ذلك).

## كتابة التهيئة

افتراضيًا، يُسمح لـ Microsoft Teams بكتابة تحديثات التهيئة التي تُشغَّل بواسطة `/config set|unset` (يتطلب `commands.config: true`).

للتعطيل:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## التحكم في الوصول (الرسائل المباشرة + المجموعات)

**الوصول للرسائل المباشرة**

- الافتراضي: `channels.msteams.dmPolicy = "pairing"`. يتم تجاهل المُرسِلين غير المعروفين حتى تتم الموافقة عليهم.
- `channels.msteams.allowFrom` يقبل معرّفات كائن AAD أو UPNs أو أسماء العرض. يقوم المعالج بحل الأسماء إلى معرّفات عبر Microsoft Graph عندما تسمح الاعتمادات.

**الوصول للمجموعات**

- الافتراضي: `channels.msteams.groupPolicy = "allowlist"` (محجوب ما لم تُضِف `groupAllowFrom`). استخدم `channels.defaults.groupPolicy` لتجاوز الافتراضي عند عدم الضبط.
- `channels.msteams.groupAllowFrom` يتحكم في أي المُرسِلين يمكنهم التفعيل في محادثات/قنوات المجموعات (يرجع إلى `channels.msteams.allowFrom`).
- عيّن `groupPolicy: "open"` للسماح لأي عضو (مع اشتراط الذِكر افتراضيًا).
- لمنع **كل القنوات**، عيّن `channels.msteams.groupPolicy: "disabled"`.

مثال:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + قائمة سماح القنوات**

- حدِّد نطاق الردود في المجموعات/القنوات بإدراج الفرق والقنوات تحت `channels.msteams.teams`.
- يمكن أن تكون المفاتيح معرّفات الفرق أو أسمائها؛ ومفاتيح القنوات يمكن أن تكون معرّفات المحادثة أو الأسماء.
- عند تعيين `groupPolicy="allowlist"` ووجود قائمة سماح للفرق، لا تُقبل إلا الفرق/القنوات المُدرجة (مع اشتراط الذِكر).
- يقبل معالج التهيئة إدخالات `Team/Channel` ويخزّنها لك.
- عند بدء التشغيل، يقوم OpenClaw بحل أسماء الفرق/القنوات وقائمة سماح المستخدمين إلى معرّفات (عندما تسمح أذونات Graph)
  ويسجّل المطابقة؛ وتُحفظ الإدخالات غير المحلولة كما كُتبت.

مثال:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## كيف يعمل

1. تثبيت مكوّن Microsoft Teams الإضافي.
2. إنشاء **Azure Bot** (معرّف التطبيق + السرّ + معرّف المستأجر).
3. إنشاء **حزمة تطبيق Teams** تشير إلى الروبوت وتتضمن أذونات RSC أدناه.
4. رفع/تثبيت تطبيق Teams داخل فريق (أو النطاق الشخصي للرسائل المباشرة).
5. تهيئة `msteams` في `~/.openclaw/openclaw.json` (أو متغيرات البيئة) وبدء الـ Gateway.
6. يستمع الـ Gateway لحركة webhook الخاصة بـ Bot Framework على `/api/messages` افتراضيًا.

## إعداد Azure Bot (المتطلبات المسبقة)

قبل تهيئة OpenClaw، تحتاج إلى إنشاء مورد Azure Bot.

### الخطوة 1: إنشاء Azure Bot

1. انتقل إلى [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. املأ تبويب **Basics**:

   | الحقل              | القيمة                                                                      |
   | ------------------ | --------------------------------------------------------------------------- |
   | **Bot handle**     | اسم الروبوت، مثل `openclaw-msteams` (يجب أن يكون فريدًا) |
   | **Subscription**   | اختر اشتراك Azure الخاص بك                                                  |
   | **Resource group** | أنشئ جديدًا أو استخدم موجودًا                                               |
   | **Pricing tier**   | **Free** للتطوير/الاختبار                                                   |
   | **Type of App**    | **Single Tenant** (موصى به – انظر الملاحظة أدناه)        |
   | **Creation type**  | **Create new Microsoft App ID**                                             |

> **إشعار إيقاف:** تم إيقاف إنشاء روبوتات متعددة المستأجرين الجديدة بعد 2025-07-31. استخدم **Single Tenant** للروبوتات الجديدة.

3. انقر **Review + create** → **Create** (انتظر ~1–2 دقيقة)

### الخطوة 2: الحصول على الاعتمادات

1. انتقل إلى مورد Azure Bot → **Configuration**
2. انسخ **Microsoft App ID** → هذا هو `appId`
3. انقر **Manage Password** → انتقل إلى تسجيل التطبيق
4. ضمن **Certificates & secrets** → **New client secret** → انسخ **Value** → هذا هو `appPassword`
5. انتقل إلى **Overview** → انسخ **Directory (tenant) ID** → هذا هو `tenantId`

### الخطوة 3: تهيئة نقطة نهاية المراسلة

1. في Azure Bot → **Configuration**
2. عيّن **Messaging endpoint** إلى عنوان URL الخاص بالويبهوك:
   - الإنتاج: `https://your-domain.com/api/messages`
   - التطوير المحلي: استخدم نفقًا (انظر [التطوير المحلي](#التطوير-المحلي-النفق) أدناه)

### الخطوة 4: تمكين قناة Teams

1. في Azure Bot → **Channels**
2. انقر **Microsoft Teams** → Configure → Save
3. وافق على شروط الخدمة

## التطوير المحلي (النفق)

لا يمكن لـ Teams الوصول إلى `localhost`. استخدم نفقًا للتطوير المحلي:

**الخيار أ: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**الخيار ب: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## بوابة مطوري Teams (بديل)

بدل إنشاء ملف manifest ZIP يدويًا، يمكنك استخدام [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. انقر **+ New app**
2. املأ المعلومات الأساسية (الاسم، الوصف، معلومات المطوّر)
3. انتقل إلى **App features** → **Bot**
4. اختر **Enter a bot ID manually** والصق معرّف تطبيق Azure Bot
5. حدّد النطاقات: **Personal**، **Team**، **Group Chat**
6. انقر **Distribute** → **Download app package**
7. في Teams: **Apps** → **Manage your apps** → **Upload a custom app** → اختر ملف ZIP

غالبًا ما يكون هذا أسهل من تحرير ملفات JSON يدويًا.

## اختبار الروبوت

**الخيار أ: Azure Web Chat (تحقق من الويبهوك أولًا)**

1. في بوابة Azure → مورد Azure Bot الخاص بك → **Test in Web Chat**
2. أرسل رسالة — يجب أن ترى ردًا
3. يؤكد ذلك أن نقطة نهاية الويبهوك تعمل قبل إعداد Teams

**الخيار ب: Teams (بعد تثبيت التطبيق)**

1. ثبّت تطبيق Teams (تحميل جانبي أو كتالوج المؤسسة)
2. اعثر على الروبوت في Teams وأرسل رسالة مباشرة
3. تحقق من سجلات الـ Gateway للنشاط الوارد

## الإعداد (نص فقط، حد أدنى)

1. **تثبيت مكوّن Microsoft Teams الإضافي**
   - من npm: `openclaw plugins install @openclaw/msteams`
   - من نسخة محلية: `openclaw plugins install ./extensions/msteams`

2. **تسجيل الروبوت**
   - أنشئ Azure Bot (انظر أعلاه) وسجّل:
     - App ID
     - Client secret (كلمة مرور التطبيق)
     - Tenant ID (مستأجر واحد)

3. **ملف manifest لتطبيق Teams**
   - تضمين إدخال `bot` مع `botId = <App ID>`.
   - النطاقات: `personal`، `team`، `groupChat`.
   - `supportsFiles: true` (مطلوب للتعامل مع الملفات في النطاق الشخصي).
   - إضافة أذونات RSC (أدناه).
   - إنشاء أيقونات: `outline.png` (32x32) و `color.png` (192x192).
   - ضغط الملفات الثلاثة معًا: `manifest.json`، `outline.png`، `color.png`.

4. **تهيئة OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   يمكنك أيضًا استخدام متغيرات البيئة بدل مفاتيح التهيئة:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **نقطة نهاية الروبوت**
   - عيّن نقطة نهاية المراسلة في Azure Bot إلى:
     - `https://<host>:3978/api/messages` (أو المسار/المنفذ الذي تختاره).

6. **تشغيل الـ Gateway**
   - تبدأ قناة Teams تلقائيًا عند تثبيت المكوّن ووجود تهيئة `msteams` مع الاعتمادات.

## سياق السجل (History)

- يتحكم `channels.msteams.historyLimit` في عدد الرسائل الأخيرة من القناة/المجموعة التي تُغلّف داخل الموجّه.
- يعود افتراضيًا إلى `messages.groupChat.historyLimit`. عيّن `0` لتعطيل ذلك (الافتراضي 50).
- يمكن تقييد سجل الرسائل المباشرة عبر `channels.msteams.dmHistoryLimit` (عدد أدوار المستخدم). تجاوزات لكل مستخدم: `channels.msteams.dms["<user_id>"].historyLimit`.

## أذونات Teams RSC الحالية (Manifest)

هذه هي **أذونات resourceSpecific** الحالية في ملف manifest لتطبيق Teams لدينا. تنطبق فقط داخل الفريق/الدردشة التي ثُبِّت فيها التطبيق.

**للقنوات (نطاق الفريق):**

- `ChannelMessage.Read.Group` (Application) – استلام كل رسائل القناة دون @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**لمحادثات المجموعات:**

- `ChatMessage.Read.Chat` (Application) – استلام كل رسائل محادثة المجموعة دون @mention

## مثال Manifest لتطبيق Teams (محذوف التفاصيل)

مثال أدنى صالح مع الحقول المطلوبة. استبدل المعرّفات وعناوين URL.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### ملاحظات Manifest (حقول إلزامية)

- `bots[].botId` **يجب** أن يطابق معرّف تطبيق Azure Bot.
- `webApplicationInfo.id` **يجب** أن يطابق معرّف تطبيق Azure Bot.
- `bots[].scopes` يجب أن يتضمن الأسطح التي تخطط لاستخدامها (`personal`، `team`، `groupChat`).
- `bots[].supportsFiles: true` مطلوب للتعامل مع الملفات في النطاق الشخصي.
- `authorization.permissions.resourceSpecific` يجب أن يتضمن قراءة/إرسال القنوات إذا أردت حركة مرور القنوات.

### تحديث تطبيق موجود

لتحديث تطبيق Teams مُثبّت مسبقًا (مثل إضافة أذونات RSC):

1. حدّث `manifest.json` بالإعدادات الجديدة
2. **زد قيمة الحقل `version`** (مثل `1.0.0` → `1.1.0`)
3. **أعد ضغط** ملف manifest مع الأيقونات (`manifest.json`، `outline.png`، `color.png`)
4. ارفع ملف zip الجديد:
   - **الخيار أ (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → اعثر على تطبيقك → Upload new version
   - **الخيار ب (تحميل جانبي):** في Teams → Apps → Manage your apps → Upload a custom app
5. **لقنوات الفرق:** أعد تثبيت التطبيق في كل فريق لتفعيل الأذونات الجديدة
6. **أغلق Teams تمامًا وأعد تشغيله** (ليس مجرد إغلاق النافذة) لمسح بيانات التعريف المخزنة مؤقتًا

## الإمكانات: RSC فقط مقابل Graph

### مع **Teams RSC فقط** (التطبيق مُثبّت، دون أذونات Graph API)

يعمل:

- قراءة محتوى **نص** رسائل القنوات.
- إرسال محتوى **نص** لرسائل القنوات.
- استلام مرفقات الملفات في **الرسائل الشخصية (DM)**.

لا يعمل:

- **محتويات الصور أو الملفات** في القنوات/المجموعات (يتضمن الحمولة مجرد HTML).
- تنزيل المرفقات المخزنة في SharePoint/OneDrive.
- قراءة سجل الرسائل (ما بعد حدث الويبهوك المباشر).

### مع **Teams RSC + أذونات Microsoft Graph (Application)**

يضيف:

- تنزيل المحتويات المستضافة (الصور الملصقة داخل الرسائل).
- تنزيل مرفقات الملفات المخزنة في SharePoint/OneDrive.
- قراءة سجل رسائل القنوات/الدردشات عبر Graph.

### RSC مقابل Graph API

| الإمكانية           | أذونات RSC                           | Graph API                                        |
| ------------------- | ------------------------------------ | ------------------------------------------------ |
| **رسائل فورية**     | نعم (عبر webhook) | لا (استطلاع فقط)              |
| **رسائل تاريخية**   | لا                                   | نعم (يمكن الاستعلام عن السجل) |
| **تعقيد الإعداد**   | ملف manifest فقط                     | يتطلب موافقة مسؤول + تدفق رموز                   |
| **العمل دون اتصال** | لا (يجب التشغيل)  | نعم (الاستعلام في أي وقت)     |

**الخلاصة:** RSC للاستماع الفوري؛ Graph API للوصول التاريخي. لتعويض الرسائل الفائتة أثناء عدم الاتصال، تحتاج Graph API مع `ChannelMessage.Read.All` (يتطلب موافقة المسؤول).

## وسائط + سجل عبر Graph (مطلوب للقنوات)

إذا احتجت الصور/الملفات في **القنوات** أو أردت جلب **سجل الرسائل**، يجب تمكين أذونات Microsoft Graph ومنح موافقة المسؤول.

1. في Entra ID (Azure AD) **تسجيل التطبيق**، أضف أذونات Microsoft Graph **Application**:
   - `ChannelMessage.Read.All` (مرفقات القنوات + السجل)
   - `Chat.Read.All` أو `ChatMessage.Read.All` (محادثات المجموعات)
2. **امنح موافقة المسؤول** للمستأجر.
3. ارفع رقم إصدار **manifest** لتطبيق Teams، أعد الرفع، و**أعد تثبيت التطبيق في Teams**.
4. **أغلق Teams تمامًا وأعد تشغيله** لمسح البيانات المخزنة مؤقتًا.

## القيود المعروفة

### مهل Webhook

تسلّم Teams الرسائل عبر webhook HTTP. إذا استغرقت المعالجة وقتًا طويلًا (مثل استجابات LLM البطيئة)، قد ترى:

- مهلات Gateway
- إعادة إرسال Teams للرسالة (مسببة تكرارات)
- إسقاط الردود

يتعامل OpenClaw مع ذلك بإرجاع استجابة بسرعة وإرسال الردود بشكل استباقي، لكن الاستجابات البطيئة جدًا قد تسبب مشكلات.

### التنسيق

Markdown في Teams أكثر محدودية من Slack أو Discord:

- يعمل التنسيق الأساسي: **غامق**، _مائل_، `code`، الروابط
- قد لا تُعرَض تنسيقات معقدة (الجداول، القوائم المتداخلة) بشكل صحيح
- بطاقات Adaptive Cards مدعومة للاستطلاعات وإرسال البطاقات عمومًا (انظر أدناه)

## التهيئة

الإعدادات الأساسية (انظر `/gateway/configuration` لأنماط القنوات المشتركة):

- `channels.msteams.enabled`: تمكين/تعطيل القناة.
- `channels.msteams.appId`، `channels.msteams.appPassword`، `channels.msteams.tenantId`: اعتمادات الروبوت.
- `channels.msteams.webhook.port` (الافتراضي `3978`)
- `channels.msteams.webhook.path` (الافتراضي `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (الافتراضي: pairing)
- `channels.msteams.allowFrom`: قائمة سماح للرسائل المباشرة (معرّفات كائن AAD أو UPNs أو أسماء العرض). يقوم المعالج بحل الأسماء إلى معرّفات أثناء الإعداد عند توفر وصول Graph.
- `channels.msteams.textChunkLimit`: حجم تقسيم النص الصادر.
- `channels.msteams.chunkMode`: `length` (افتراضي) أو `newline` للتقسيم عند الأسطر الفارغة (حدود الفقرات) قبل التقسيم حسب الطول.
- `channels.msteams.mediaAllowHosts`: قائمة سماح لمضيفي المرفقات الواردة (الافتراضي نطاقات Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts`: قائمة سماح لإرفاق رؤوس Authorization عند إعادة محاولة الوسائط (الافتراضي مضيفو Graph + Bot Framework).
- `channels.msteams.requireMention`: اشتراط @mention في القنوات/المجموعات (افتراضي true).
- `channels.msteams.replyStyle`: `thread | top-level` (انظر [نمط الرد](#نمط-الرد-السلاسل-مقابل-المنشورات)).
- `channels.msteams.teams.<teamId>.replyStyle`: تجاوز لكل فريق.
- `channels.msteams.teams.<teamId>.requireMention`: تجاوز لكل فريق.
- `channels.msteams.teams.<teamId>.tools`: تجاوزات افتراضية لسياسات الأدوات لكل فريق (`allow`/`deny`/`alsoAllow`) تُستخدم عند غياب تجاوز القناة.
- `channels.msteams.teams.<teamId>.toolsBySender`: تجاوزات افتراضية لسياسات الأدوات لكل فريق ولكل مُرسِل (`"*"` مدعوم).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: تجاوز لكل قناة.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: تجاوز لكل قناة.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: تجاوزات سياسات الأدوات لكل قناة (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: تجاوزات سياسات الأدوات لكل قناة ولكل مُرسِل (`"*"` مدعوم).
- `channels.msteams.sharePointSiteId`: معرّف موقع SharePoint لرفع الملفات في محادثات/قنوات المجموعات (انظر [إرسال الملفات في محادثات المجموعات](#إرسال-الملفات-في-محادثات-المجموعات)).

## التوجيه والجلسات

- تتبع مفاتيح الجلسة تنسيق الوكيل القياسي (انظر [/concepts/session](/concepts/session)):
  - الرسائل المباشرة تشترك في الجلسة الرئيسية (`agent:<agentId>:<mainKey>`).
  - رسائل القنوات/المجموعات تستخدم معرّف المحادثة:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## نمط الرد: السلاسل مقابل المنشورات

قدّمت Teams مؤخرًا نمطي واجهة للقنوات فوق نفس نموذج البيانات الأساسي:

| النمط                                           | الوصف                                      | `replyStyle` الموصى به                |
| ----------------------------------------------- | ------------------------------------------ | ------------------------------------- |
| **المنشورات** (كلاسيكي)      | تظهر الرسائل كبطاقات مع ردود متفرعة أسفلها | `thread` (افتراضي) |
| **السلاسل** (مشابه لـ Slack) | تتدفق الرسائل خطيًا، مثل Slack             | `top-level`                           |

**المشكلة:** لا تكشف واجهة Teams API عن نمط الواجهة المستخدم في القناة. إذا استخدمت `replyStyle` الخاطئ:

- `thread` في قناة بنمط السلاسل → تظهر الردود متداخلة بشكل غير ملائم
- `top-level` في قناة بنمط المنشورات → تظهر الردود كمنشورات عليا منفصلة بدل الرد داخل السلسلة

**الحل:** اضبط `replyStyle` لكل قناة وفق إعداد القناة:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## المرفقات والصور

**القيود الحالية:**

- **الرسائل المباشرة:** تعمل الصور ومرفقات الملفات عبر واجهات ملفات روبوت Teams.
- **القنوات/المجموعات:** تعيش المرفقات في تخزين M365 (SharePoint/OneDrive). تتضمن حمولة الويبهوك مجرد HTML، وليس بايتات الملف الفعلية. **أذونات Graph API مطلوبة** لتنزيل مرفقات القنوات.

بدون أذونات Graph، ستُستلم رسائل القنوات التي تحتوي على صور كنص فقط (لا يمكن للروبوت الوصول إلى محتوى الصورة).
افتراضيًا، يقوم OpenClaw بتنزيل الوسائط فقط من مضيفي Microsoft/Teams. تجاوز ذلك عبر `channels.msteams.mediaAllowHosts` (استخدم `["*"]` للسماح بأي مضيف).
تُرفق رؤوس Authorization فقط للمضيفين في `channels.msteams.mediaAuthAllowHosts` (الافتراضي مضيفو Graph + Bot Framework). حافظ على صرامة هذه القائمة (وتجنب لاحقات متعددة المستأجرين).

## إرسال الملفات في محادثات المجموعات

يمكن للروبوتات إرسال الملفات في الرسائل المباشرة باستخدام تدفق FileConsentCard (مدمج). لكن **إرسال الملفات في محادثات/قنوات المجموعات** يتطلب إعدادًا إضافيًا:

| السياق                                 | كيفية إرسال الملفات                           | الإعداد المطلوب                         |
| -------------------------------------- | --------------------------------------------- | --------------------------------------- |
| **الرسائل المباشرة**                   | FileConsentCard → قبول المستخدم → رفع الروبوت | يعمل خارج الصندوق                       |
| **محادثات/قنوات المجموعات**            | رفع إلى SharePoint → مشاركة رابط              | يتطلب `sharePointSiteId` + أذونات Graph |
| **الصور (أي سياق)** | مضمنة Base64                                  | يعمل خارج الصندوق                       |

### لماذا تحتاج محادثات المجموعات إلى SharePoint

لا تمتلك الروبوتات محرك OneDrive شخصيًا (نقطة نهاية Graph API `/me/drive` لا تعمل لهويات التطبيقات). لإرسال الملفات في محادثات/قنوات المجموعات، يرفع الروبوت إلى **موقع SharePoint** وينشئ رابط مشاركة.

### الإعداد

1. **إضافة أذونات Graph API** في Entra ID (Azure AD) → تسجيل التطبيق:
   - `Sites.ReadWrite.All` (Application) – رفع الملفات إلى SharePoint
   - `Chat.Read.All` (Application) – اختياري، يفعّل روابط مشاركة لكل مستخدم

2. **منح موافقة المسؤول** للمستأجر.

3. **الحصول على معرّف موقع SharePoint:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **تهيئة OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### سلوك المشاركة

| الإذن                                   | سلوك المشاركة                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `Sites.ReadWrite.All` فقط               | رابط مشاركة على مستوى المؤسسة (يمكن لأي شخص في المؤسسة الوصول) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | رابط مشاركة لكل مستخدم (فقط أعضاء الدردشة يمكنهم الوصول)       |

تُعد المشاركة لكل مستخدم أكثر أمانًا لأن المشاركين في الدردشة فقط يمكنهم الوصول إلى الملف. إذا كان إذن `Chat.Read.All` مفقودًا، يعود الروبوت إلى المشاركة على مستوى المؤسسة.

### سلوك الرجوع (Fallback)

| السيناريو                                     | النتيجة                                                        |
| --------------------------------------------- | -------------------------------------------------------------- |
| محادثة مجموعة + ملف + ضبط `sharePointSiteId`  | الرفع إلى SharePoint وإرسال رابط مشاركة                        |
| محادثة مجموعة + ملف + بدون `sharePointSiteId` | محاولة رفع OneDrive (قد تفشل) وإرسال نص فقط |
| محادثة شخصية + ملف                            | تدفق FileConsentCard (يعمل دون SharePoint)  |
| أي سياق + صورة                                | مضمنة Base64 (تعمل دون SharePoint)          |

### موقع تخزين الملفات

تُخزَّن الملفات المرفوعة في مجلد `/OpenClawShared/` داخل مكتبة المستندات الافتراضية لموقع SharePoint المُهيّأ.

## الاستطلاعات (Adaptive Cards)

يرسل OpenClaw استطلاعات Teams كبطاقات Adaptive Cards (لا توجد واجهة برمجة استطلاعات أصلية في Teams).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- تُسجَّل الأصوات بواسطة الـ Gateway في `~/.openclaw/msteams-polls.json`.
- يجب أن يبقى الـ Gateway متصلًا لتسجيل الأصوات.
- لا يتم نشر ملخصات النتائج تلقائيًا بعد (افحص ملف التخزين عند الحاجة).

## بطاقات Adaptive (عامّة)

أرسل أي JSON لبطاقة Adaptive إلى مستخدمي Teams أو المحادثات باستخدام أداة أو CLI `message`.

يقبل المعامل `card` كائن JSON لبطاقة Adaptive. عند توفير `card`، يصبح نص الرسالة اختياريًا.

**أداة الوكيل:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

انظر [وثائق Adaptive Cards](https://adaptivecards.io/) لمخطط البطاقات والأمثلة. لتفاصيل تنسيق الهدف، انظر [تنسيقات الهدف](#تنسيقات-الهدف) أدناه.

## تنسيقات الهدف

تستخدم أهداف MSTeams بادئات للتمييز بين المستخدمين والمحادثات:

| نوع الهدف                            | التنسيق                          | مثال                                                                     |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| مستخدم (بالمعرّف) | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                              |
| مستخدم (بالاسم)   | `user:<display-name>`            | `user:John Smith` (يتطلب Graph API)                   |
| مجموعة/قناة                          | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                 |
| مجموعة/قناة (خام) | `<conversation-id>`              | `19:abc123...@thread.tacv2` (إذا احتوى على `@thread`) |

**أمثلة CLI:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**أمثلة أداة الوكيل:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

ملاحظة: بدون البادئة `user:`، تُحل الأسماء افتراضيًا إلى مجموعات/فرق. استخدم دائمًا `user:` عند استهداف الأشخاص باسم العرض.

## رسالة استباقية

- لا تكون الرسائل الاستباقية ممكنة إلا **بعد** تفاعل المستخدم، لأننا نخزّن مراجع المحادثة عند تلك النقطة.
- انظر `/gateway/configuration` بخصوص `dmPolicy` وبوابات قوائم السماح.

## معرّفات الفرق والقنوات (خطأ شائع)

معامل الاستعلام `groupId` في عناوين URL الخاصة بـ Teams **ليس** معرّف الفريق المستخدم في التهيئة. استخرج المعرّفات من مسار URL بدلًا من ذلك:

**عنوان URL للفريق:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**عنوان URL للقناة:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**للتهيئة:**

- معرّف الفريق = مقطع المسار بعد `/team/` (بعد فك الترميز، مثل `19:Bk4j...@thread.tacv2`)
- معرّف القناة = مقطع المسار بعد `/channel/` (بعد فك الترميز)
- **تجاهل** معامل الاستعلام `groupId`

## القنوات الخاصة

الدعم محدود للروبوتات في القنوات الخاصة:

| الميزة                                       | القنوات القياسية | القنوات الخاصة                       |
| -------------------------------------------- | ---------------- | ------------------------------------ |
| تثبيت بوت                                    | نعم              | محدود                                |
| الرسائل الفورية (webhook) | نعم              | قد لا يعمل                           |
| أذونات RSC                                   | نعم              | قد تتصرف بشكل مختلف                  |
| @mentions                       | نعم              | إذا كان الروبوت متاحًا               |
| سجل Graph API                                | نعم              | نعم (مع الأذونات) |

**حلول بديلة إذا لم تعمل القنوات الخاصة:**

1. استخدام القنوات القياسية لتفاعلات الروبوت
2. استخدام الرسائل المباشرة — يمكن للمستخدمين دائمًا مراسلة الروبوت مباشرة
3. استخدام Graph API للوصول التاريخي (يتطلب `ChannelMessage.Read.All`)

## استكشاف الأخطاء وإصلاحها

### مشكلات شائعة

- **الصور لا تظهر في القنوات:** أذونات Graph أو موافقة المسؤول مفقودة. أعد تثبيت تطبيق Teams وأغلق/أعد فتح Teams بالكامل.
- **لا توجد ردود في القناة:** الذِكر مطلوب افتراضيًا؛ عيّن `channels.msteams.requireMention=false` أو اضبط لكل فريق/قناة.
- **عدم تطابق الإصدار (Teams ما زال يعرض manifest قديمًا):** أزل التطبيق وأعد إضافته وأغلق Teams بالكامل للتحديث.
- **401 Unauthorized من الويبهوك:** متوقع عند الاختبار اليدوي دون JWT من Azure — يعني أن نقطة النهاية قابلة للوصول لكن فشل التوثيق. استخدم Azure Web Chat للاختبار الصحيح.

### أخطاء رفع Manifest

- **«Icon file cannot be empty»:** يشير manifest إلى أيقونات حجمها 0 بايت. أنشئ أيقونات PNG صالحة (32x32 لـ `outline.png`، و192x192 لـ `color.png`).
- **«webApplicationInfo.Id already in use»:** التطبيق ما زال مُثبّتًا في فريق/دردشة أخرى. اعثر عليه وألغِ تثبيته أولًا، أو انتظر 5–10 دقائق للانتشار.
- **«Something went wrong» عند الرفع:** ارفع عبر [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) بدلًا من ذلك، وافتح أدوات المطوّر في المتصفح (F12) → تبويب Network، وتحقق من جسم الاستجابة للخطأ الفعلي.
- **فشل التحميل الجانبي:** جرّب «Upload an app to your org's app catalog» بدل «Upload a custom app» — غالبًا ما يتجاوز قيود التحميل الجانبي.

### أذونات RSC لا تعمل

1. تحقق من أن `webApplicationInfo.id` يطابق معرّف تطبيق الروبوت بدقة
2. أعد رفع التطبيق وأعد تثبيته في الفريق/الدردشة
3. تحقق مما إذا كان مسؤول المؤسسة قد حظر أذونات RSC
4. تأكد من استخدام النطاق الصحيح: `ChannelMessage.Read.Group` للفرق، و`ChatMessage.Read.Chat` لمحادثات المجموعات

## المراجع

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) – دليل إعداد Azure Bot
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) – إنشاء/إدارة تطبيقات Teams
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (القنوات/المجموعات تتطلب Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
