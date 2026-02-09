---
summary: "إضافات/امتدادات OpenClaw: الاكتشاف، التهيئة، والسلامة"
read_when:
  - إضافة أو تعديل الإضافات/الامتدادات
  - توثيق قواعد تثبيت أو تحميل الإضافات
title: "الإضافات"
---

# الإضافات (الامتدادات)

## البدء السريع (هل أنت جديد على الإضافات؟)

الإضافة هي مجرد **وحدة شيفرة صغيرة** توسّع OpenClaw بميزات إضافية
(أوامر، أدوات، وGateway RPC).

في معظم الأوقات، ستستخدم الإضافات عندما تريد ميزة غير مضمّنة بعد في نواة OpenClaw
(أو عندما ترغب في إبقاء الميزات الاختيارية خارج التثبيت الرئيسي).

المسار السريع:

1. انظر ما تم تحميله بالفعل:

```bash
openclaw plugins list
```

2. ثبّت إضافة رسمية (مثال: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. أعد تشغيل Gateway، ثم قم بالتهيئة ضمن `plugins.entries.<id>.config`.

انظر [Voice Call](/plugins/voice-call) لمثال عملي على إضافة.

## الإضافات المتاحة (الرسمية)

- Microsoft Teams متاح عبر الإضافة فقط اعتبارًا من 2026.1.15؛ ثبّت `@openclaw/msteams` إذا كنت تستخدم Teams.
- Memory (Core) — إضافة بحث الذاكرة المجمّعة (مفعّلة افتراضيًا عبر `plugins.slots.memory`)
- Memory (LanceDB) — إضافة ذاكرة طويلة الأمد مجمّعة (استدعاء/التقاط تلقائي؛ اضبط `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (مصادقة الموفّر) — مضمّنة كـ `google-antigravity-auth` (معطّلة افتراضيًا)
- Gemini CLI OAuth (مصادقة الموفّر) — مضمّنة كـ `google-gemini-cli-auth` (معطّلة افتراضيًا)
- Qwen OAuth (مصادقة الموفّر) — مضمّنة كـ `qwen-portal-auth` (معطّلة افتراضيًا)
- Copilot Proxy (مصادقة الموفّر) — جسر محلي لـ VS Code Copilot Proxy؛ مميّز عن تسجيل الدخول المضمّن `github-copilot` للجهاز (مضمّن، معطّل افتراضيًا)

إضافات OpenClaw هي **وحدات TypeScript** تُحمَّل في وقت التشغيل عبر jiti. **التحقق من التهيئة لا ينفّذ شيفرة الإضافة**؛ بل يستخدم بيان الإضافة وJSON Schema بدلًا من ذلك. راجع [بيان الإضافة](/plugins/manifest).

يمكن للإضافات تسجيل:

- أساليب Gateway RPC
- معالجات Gateway HTTP
- أدوات الوكيل
- أوامر CLI
- خدمات تعمل في الخلفية
- تحقق اختياري من التهيئة
- **Skills** (بإدراج أدلة `skills` في بيان الإضافة)
- **أوامر الردّ التلقائي** (تُنفَّذ دون استدعاء وكيل الذكاء الاصطناعي)

تعمل الإضافات **داخل العملية** مع Gateway، لذا اعتبرها شيفرة موثوقة.
دليل تأليف الأدوات: [Plugin agent tools](/plugins/agent-tools).

## مساعدات وقت التشغيل

يمكن للإضافات الوصول إلى بعض مساعدات النواة المختارة عبر `api.runtime`. لتحويل النص إلى كلام للاتصال الهاتفي:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

ملاحظات:

- يستخدم تهيئة النواة `messages.tts` (OpenAI أو ElevenLabs).
- يُرجِع مخزنًا صوتيًا PCM + معدل العيّنة. يجب على الإضافات إعادة أخذ العينات/الترميز للموفّرين.
- Edge TTS غير مدعوم للاتصال الهاتفي.

## الاكتشاف والأولوية

يقوم OpenClaw بالمسح بالترتيب:

1. مسارات التهيئة

- `plugins.load.paths` (ملف أو دليل)

2. امتدادات مساحة العمل

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. الامتدادات العامة

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. الامتدادات المجمّعة (المشحوذة مع OpenClaw، **معطّلة افتراضيًا**)

- `<openclaw>/extensions/*`

يجب تمكين الإضافات المجمّعة صراحةً عبر `plugins.entries.<id>.enabled`
أو `openclaw plugins enable <id>`. الإضافات المثبّتة تكون مفعّلة افتراضيًا،
لكن يمكن تعطيلها بالطريقة نفسها.

يجب أن تتضمن كل إضافة ملف `openclaw.plugin.json` في جذرها. إذا
أشار مسار إلى ملف، فإن جذر الإضافة هو دليل الملف ويجب أن يحتوي
على البيان.

إذا حُلَّت عدة إضافات إلى المعرّف نفسه، يفوز أول تطابق وفق الترتيب أعلاه
ويتم تجاهل النسخ ذات الأولوية الأدنى.

### حِزم الحِزم (Package packs)

قد يتضمن دليل الإضافة ملف `package.json` مع `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

يصبح كل إدخال إضافة. إذا سردت الحزمة عدة امتدادات، يصبح معرّف الإضافة
`name/<fileBase>`.

إذا كانت إضافتك تستورد تبعيات npm، فقم بتثبيتها في ذلك الدليل بحيث
يتوفر `node_modules` (`npm install` / `pnpm install`).

### بيانات فهرس القنوات

يمكن لإضافات القنوات الإعلان عن بيانات التهيئة الأولية عبر `openclaw.channel`
وتلميحات التثبيت عبر `openclaw.install`. هذا يُبقي بيانات الفهرس في النواة خالية من البيانات.

مثال:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

يمكن لـ OpenClaw أيضًا دمج **فهارس قنوات خارجية** (على سبيل المثال، تصدير سجل MPM). ضع ملف JSON في أحد المسارات التالية:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

أو وجّه `OPENCLAW_PLUGIN_CATALOG_PATHS` (أو `OPENCLAW_MPM_CATALOG_PATHS`) إلى
ملف JSON واحد أو أكثر (مفصولة بفواصل/فواصل منقوطة/`PATH`). يجب أن يحتوي كل ملف
على `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## معرفات الاضافات

معرّفات الإضافات الافتراضية:

- حِزم الحِزم: `package.json` `name`
- ملف مستقل: اسم قاعدة الملف (`~/.../voice-call.ts` → `voice-call`)

إذا صدّرت إضافة `id`، يستخدمه OpenClaw لكنه يحذّر عندما لا يطابق
المعرّف المُهيّأ.

## التهيئة

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

الحقول:

- `enabled`: مفتاح التشغيل الرئيسي (الافتراضي: true)
- `allow`: قائمة السماح (اختيارية)
- `deny`: قائمة الحظر (اختيارية؛ الحظر يتغلّب)
- `load.paths`: ملفات/أدلة إضافات إضافية
- `entries.<id>`: مفاتيح تشغيل/إيقاف لكل إضافة + التهيئة

تتطلب تغييرات التهيئة **إعادة تشغيل Gateway**.

قواعد التحقق (صارمة):

- معرّفات إضافات غير معروفة في `entries`، `allow`، `deny`، أو `slots` هي **أخطاء**.
- مفاتيح `channels.<id>` غير المعروفة هي **أخطاء** ما لم يعلن بيان الإضافة
  معرّف القناة.
- يتم التحقق من تهيئة الإضافة باستخدام JSON Schema المضمّن في
  `openclaw.plugin.json` (`configSchema`).
- إذا كانت الإضافة معطّلة، تُحفَظ تهيئتها ويُصدَر **تحذير**.

## فتحات الإضافات (فئات حصرية)

بعض فئات الإضافات **حصرية** (نشطة واحدة فقط في الوقت نفسه). استخدم
`plugins.slots` لاختيار الإضافة التي تملك الفتحة:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

إذا أعلنت عدة إضافات `kind: "memory"`، فسيتم تحميل المختارة فقط. الأخرى
تُعطَّل مع تشخيصات.

## واجهة التحكم (المخطط + التسميات)

تستخدم واجهة التحكم `config.schema` (JSON Schema + `uiHints`) لعرض نماذج أفضل.

يعزّز OpenClaw `uiHints` في وقت التشغيل بناءً على الإضافات المكتشفة:

- يضيف تسميات لكل إضافة لـ `plugins.entries.<id>` / `.enabled` / `.config`
- يدمج تلميحات حقول التهيئة الاختيارية التي توفّرها الإضافات ضمن:
  `plugins.entries.<id>.config.<field>`

إذا أردت أن تُظهر حقول تهيئة إضافتك تسميات/عناصر نائبة جيدة (وتمييز الأسرار كحسّاسة)،
فوفّر `uiHints` إلى جانب JSON Schema في بيان الإضافة.

مثال:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` يعمل فقط لتثبيتات npm المتتبَّعة ضمن `plugins.installs`.

يمكن للإضافات أيضًا تسجيل أوامر عليا خاصة بها (مثال: `openclaw voicecall`).

## إضافة API (نظرة عامة)

تصدير الإضافات إما:

- دالة: `(api) => { ... }`
- كائن: `{ id, name, configSchema, register(api) { ... } }`

## خطافات الإضافات

يمكن للإضافات شحن خطافات وتسجيلها في وقت التشغيل. يتيح ذلك تجميع أتمتة قائمة على الأحداث
دون تثبيت حزمة خطافات منفصلة.

### مثال

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

ملاحظات:

- تتبع أدلة الخطافات البنية المعتادة للخطافات (`HOOK.md` + `handler.ts`).
- تظل قواعد أهلية الخطافات سارية (متطلبات نظام التشغيل/الثنائيات/البيئة/التهيئة).
- تظهر الخطافات المُدارة عبر الإضافات في `openclaw hooks list` مع `plugin:<id>`.
- لا يمكنك تمكين/تعطيل الخطافات المُدارة عبر الإضافات عبر `openclaw hooks`؛ بدلاً من ذلك فعِّل/عطِّل الإضافة.

## إضافات الموفّرين (مصادقة النماذج)

يمكن للإضافات تسجيل تدفقات **مصادقة موفّر النماذج** بحيث يمكن للمستخدمين تشغيل OAuth أو
إعداد مفاتيح API داخل OpenClaw (دون الحاجة إلى سكربتات خارجية).

سجّل موفّرًا عبر `api.registerProvider(...)`. يعرِض كل موفّر
طريقة مصادقة واحدة أو أكثر (OAuth، مفتاح API، رمز الجهاز، إلخ). تُغذّي هذه الطرق:

- `openclaw models auth login --provider <id> [--method <id>]`

مثال:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

ملاحظات:

- يستقبل `run` كائن `ProviderAuthContext` مع مساعدات `prompter`، `runtime`،
  `openUrl`، و `oauth.createVpsAwareHandlers`.
- أعد `configPatch` عندما تحتاج إلى إضافة نماذج افتراضية أو تهيئة الموفّر.
- أعد `defaultModel` بحيث يتمكن `--set-default` من تحديث افتراضيات الوكيل.

### تسجيل قناة مراسلة

يمكن للإضافات تسجيل **إضافات قنوات** تتصرّف مثل القنوات المضمّنة
(WhatsApp، Telegram، إلخ). تعيش تهيئة القناة ضمن `channels.<id>` ويتم
التحقق منها بواسطة شيفرة إضافة القناة الخاصة بك.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

ملاحظات:

- ضع التهيئة ضمن `channels.<id>` (وليس `plugins.entries`).
- يُستخدم `meta.label` للتسميات في قوائم CLI/واجهة المستخدم.
- يضيف `meta.aliases` معرّفات بديلة للتطبيع وإدخالات CLI.
- يسرد `meta.preferOver` معرّفات القنوات التي يجب تخطي التمكين التلقائي عند تهيئة كليهما.
- يتيح `meta.detailLabel` و `meta.systemImage` لواجهات المستخدم عرض تسميات/أيقونات قنوات أغنى.

### كتابة قناة مراسلة جديدة (خطوة بخطوة)

استخدم هذا عندما تريد **سطح دردشة جديد** («قناة مراسلة»)، وليس موفّر نماذج.
تقع مستندات موفّر النماذج ضمن `/providers/*`.

1. اختر معرّفًا + شكل التهيئة

- تعيش جميع تهيئة القنوات ضمن `channels.<id>`.
- فضّل `channels.<id>.accounts.<accountId>` لإعدادات الحسابات المتعددة.

2. عرّف بيانات القناة الوصفية

- تتحكم `meta.label`، `meta.selectionLabel`، `meta.docsPath`، `meta.blurb` في قوائم CLI/واجهة المستخدم.
- يجب أن يشير `meta.docsPath` إلى صفحة توثيق مثل `/channels/<id>`.
- يتيح `meta.preferOver` لإضافة استبدال قناة أخرى (يفضّل التمكين التلقائي).
- تُستخدم `meta.detailLabel` و `meta.systemImage` بواسطة واجهات المستخدم لنصوص/أيقونات التفاصيل.

3. نفّذ المحوّلات المطلوبة

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (أنواع الدردشة، الوسائط، الخيوط، إلخ)
- `outbound.deliveryMode` + `outbound.sendText` (للإرسال الأساسي)

4. أضف محوّلات اختيارية حسب الحاجة

- `setup` (معالج)، `security` (سياسة الرسائل الخاصة)، `status` (الصحة/التشخيص)
- `gateway` (بدء/إيقاف/تسجيل الدخول)، `mentions`، `threading`، `streaming`
- `actions` (إجراءات الرسائل)، `commands` (سلوك الأوامر الأصلي)

5. سجّل القناة في إضافتك

- `api.registerChannel({ plugin })`

مثال تهيئة أدنى:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

إضافة قناة أدنى (إرسال فقط للخارج):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

حمّل الإضافة (دليل الامتدادات أو `plugins.load.paths`)، أعد تشغيل Gateway،
ثم قم بتهيئة `channels.<id>` في تهيئتك.

### أدوات الوكيل

انظر الدليل المخصّص: [Plugin agent tools](/plugins/agent-tools).

### تسجيل أسلوب Gateway RPC

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### تسجيل أوامر CLI

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### تسجيل أوامر الردّ التلقائي

يمكن للإضافات تسجيل أوامر شرطة مائلة مخصّصة تُنفَّذ **دون استدعاء
وكيل الذكاء الاصطناعي**. هذا مفيد لأوامر التبديل، فحوصات الحالة، أو الإجراءات السريعة
التي لا تحتاج إلى معالجة LLM.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

سياق معالج الأمر:

- `senderId`: معرّف المُرسل (إن كان متاحًا)
- `channel`: القناة التي أُرسل فيها الأمر
- `isAuthorizedSender`: ما إذا كان المُرسل مستخدمًا مخوّلًا
- `args`: الوسائط المُمرّرة بعد الأمر (إذا كان `acceptsArgs: true`)
- `commandBody`: نص الأمر الكامل
- `config`: تهيئة OpenClaw الحالية

خيارات الأمر:

- `name`: اسم الأمر (دون البادئة `/`)
- `description`: نص المساعدة المعروض في قوائم الأوامر
- `acceptsArgs`: ما إذا كان الأمر يقبل وسيطات (الافتراضي: false). إذا كان false وتم تمرير وسيطات، فلن يتطابق الأمر وتسقط الرسالة إلى معالجات أخرى
- `requireAuth`: ما إذا كان يتطلب مُرسلًا مخوّلًا (الافتراضي: true)
- `handler`: دالة تُرجِع `{ text: string }` (يمكن أن تكون async)

مثال مع التفويض والوسائط:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

ملاحظات:

- تُعالَج أوامر الإضافات **قبل** الأوامر المضمّنة ووكيل الذكاء الاصطناعي
- تُسجَّل الأوامر عالميًا وتعمل عبر جميع القنوات
- أسماء الأوامر غير حسّاسة لحالة الأحرف (`/MyStatus` يطابق `/mystatus`)
- يجب أن تبدأ أسماء الأوامر بحرف وأن تحتوي فقط على أحرف وأرقام وواصلات وشرطات سفلية
- لا يمكن للإضافات تجاوز أسماء الأوامر المحجوزة (مثل `help`، `status`، `reset`، إلخ) لا يمكن تجاوزها بواسطة الإضافات
- سيؤدي تسجيل أوامر مكرّرة عبر إضافات متعددة إلى الفشل مع خطأ تشخيصي

### تسجيل خدمات تعمل في الخلفية

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## اتفاقيات التسمية

- أساليب Gateway: `pluginId.action` (مثال: `voicecall.status`)
- الأدوات: `snake_case` (مثال: `voice_call`)
- أوامر CLI: kebab أو camel، لكن تجنّب التعارض مع أوامر النواة

## Skills

يمكن للإضافات شحن Skill في المستودع (`skills/<name>/SKILL.md`).
قم بتمكينه عبر `plugins.entries.<id>.enabled` (أو بوابات تهيئة أخرى) وتأكد
من وجوده في مواقع Skills لمساحة العمل/الإدارة.

## التوزيع (npm)

التغليف الموصى به:

- الحزمة الرئيسية: `openclaw` (هذا المستودع)
- الإضافات: حزم npm منفصلة ضمن `@openclaw/*` (مثال: `@openclaw/voice-call`)

عقد النشر:

- يجب أن يتضمن `package.json` للإضافة `openclaw.extensions` مع ملف إدخال واحد أو أكثر.
- يمكن أن تكون ملفات الإدخال `.js` أو `.ts` (يحمل jiti TypeScript في وقت التشغيل).
- يستخدم `openclaw plugins install <npm-spec>` `npm pack`، ويستخرج إلى `~/.openclaw/extensions/<id>/`، ويمكّنه في التهيئة.
- ثبات مفاتيح التهيئة: تُطبَّع الحزم ذات النطاق إلى المعرّف **غير ذي النطاق** لـ `plugins.entries.*`.

## مثال إضافة: Voice Call

يتضمن هذا المستودع إضافة مكالمات صوتية (Twilio أو بديل السجل):

- المصدر: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- الأداة: `voice_call`
- RPC: `voicecall.start`، `voicecall.status`
- التهيئة (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (اختياري `statusCallbackUrl`، `twimlUrl`)
- التهيئة (dev): `provider: "log"` (بدون شبكة)

انظر [Voice Call](/plugins/voice-call) و `extensions/voice-call/README.md` للإعداد والاستخدام.

## ملاحظات السلامة

تعمل الإضافات داخل العملية مع Gateway. اعتبرها شيفرة موثوقة:

- ثبّت فقط الإضافات التي تثق بها.
- فضّل قوائم السماح `plugins.allow`.
- أعد تشغيل Gateway بعد التغييرات.

## اختبار الإضافات

يمكن للإضافات (وينبغي لها) شحن اختبارات:

- يمكن للإضافات داخل المستودع الاحتفاظ باختبارات Vitest ضمن `src/**` (مثال: `src/plugins/voice-call.plugin.test.ts`).
- يجب على الإضافات المنشورة بشكل منفصل تشغيل CI خاص بها (lint/build/test) والتحقق من أن `openclaw.extensions` يشير إلى نقطة الإدخال المبنية (`dist/index.js`).
