---
summary: "OpenClaw پلگ اِنز/ایکسٹینشنز: ڈسکوری، کنفیگ، اور حفاظت"
read_when:
  - پلگ اِنز/ایکسٹینشنز شامل یا تبدیل کرتے وقت
  - پلگ اِن کی انسٹال یا لوڈ قواعد کی دستاویز سازی
title: "پلگ اِنز"
---

# پلگ اِنز (ایکسٹینشنز)

## فوری آغاز (پلگ اِنز کے لیے نئے ہیں؟)

پلگ اِن محض ایک **چھوٹا کوڈ ماڈیول** ہوتا ہے جو OpenClaw کو اضافی
خصوصیات (کمانڈز، اوزار، اور Gateway RPC) کے ساتھ وسعت دیتا ہے۔

اکثر اوقات، آپ پلگ اِنز اس وقت استعمال کریں گے جب آپ کو ایسی خصوصیت درکار ہو
جو ابھی کور OpenClaw میں شامل نہ ہو (یا آپ اختیاری خصوصیات کو اپنی مرکزی انسٹالیشن سے الگ رکھنا چاہتے ہوں)۔

تیز راستہ:

1. دیکھیں کہ اس وقت کیا لوڈ ہے:

```bash
openclaw plugins list
```

2. ایک سرکاری پلگ اِن انسٹال کریں (مثال: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Restart the Gateway, then configure under `plugins.entries.<id>.config`.

ایک ٹھوس مثال پلگ اِن کے لیے [Voice Call](/plugins/voice-call) دیکھیں۔

## دستیاب پلگ اِنز (سرکاری)

- Microsoft Teams بطورِ 2026.1.15 صرف پلگ اِن کے ذریعے دستیاب ہے؛ اگر آپ Teams استعمال کرتے ہیں تو `@openclaw/msteams` انسٹال کریں۔
- Memory (Core) — بنڈلڈ میموری سرچ پلگ اِن (بطورِ طے شدہ فعال بذریعہ `plugins.slots.memory`)
- Memory (LanceDB) — بنڈلڈ طویل مدتی میموری پلگ اِن (خودکار ریکال/کیپچر؛ `plugins.slots.memory = "memory-lancedb"` سیٹ کریں)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (provider auth) — بطورِ `google-antigravity-auth` بنڈلڈ (بطورِ طے شدہ غیرفعال)
- Gemini CLI OAuth (provider auth) — بطورِ `google-gemini-cli-auth` بنڈلڈ (بطورِ طے شدہ غیرفعال)
- Qwen OAuth (provider auth) — بطورِ `qwen-portal-auth` بنڈلڈ (بطورِ طے شدہ غیرفعال)
- Copilot Proxy (provider auth) — مقامی VS Code Copilot Proxy برج؛ بلٹ اِن `github-copilot` ڈیوائس لاگ اِن سے مختلف (بنڈلڈ، بطورِ طے شدہ غیرفعال)

OpenClaw plugins are **TypeScript modules** loaded at runtime via jiti. **Config
validation does not execute plugin code**; it uses the plugin manifest and JSON
Schema instead. See [Plugin manifest](/plugins/manifest).

پلگ اِنز درج ذیل رجسٹر کر سکتے ہیں:

- Gateway RPC میتھڈز
- Gateway HTTP ہینڈلرز
- ایجنٹ اوزار
- CLI کمانڈز
- بیک گراؤنڈ سروسز
- اختیاری کنفیگ توثیق
- **Skills** (پلگ اِن مینِفیسٹ میں `skills` ڈائریکٹریز درج کر کے)
- **خودکار جواب کمانڈز** (AI ایجنٹ کو بلاۓ بغیر اجرا)

Plugins run **in‑process** with the Gateway, so treat them as trusted code.
Tool authoring guide: [Plugin agent tools](/plugins/agent-tools).

## رن ٹائم مددگار

Plugins can access selected core helpers via `api.runtime`. For telephony TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

نوٹس:

- کور `messages.tts` کنفیگریشن استعمال ہوتی ہے (OpenAI یا ElevenLabs)۔
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.
- Edge TTS ٹیلی فونی کے لیے معاونت یافتہ نہیں ہے۔

## ڈسکوری اور ترجیح

OpenClaw درج ذیل ترتیب میں اسکین کرتا ہے:

1. کنفیگ راستے

- `plugins.load.paths` (فائل یا ڈائریکٹری)

2. ورک اسپیس ایکسٹینشنز

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. گلوبل ایکسٹینشنز

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. بنڈلڈ ایکسٹینشنز (OpenClaw کے ساتھ فراہم کردہ، **بطورِ طے شدہ غیرفعال**)

- `<openclaw>/extensions/*`

Bundled plugins must be enabled explicitly via `plugins.entries.<id>.enabled`
or `openclaw plugins enable <id>`. Installed plugins are enabled by default,
but can be disabled the same way.

Each plugin must include a `openclaw.plugin.json` file in its root. If a path
points at a file, the plugin root is the file's directory and must contain the
manifest.

اگر متعدد پلگ اِنز ایک ہی id پر حل ہوں، تو اوپر دی گئی ترتیب میں پہلا میچ جیتتا ہے اور کم ترجیح والی نقول نظرانداز کر دی جاتی ہیں۔

### پیکیج پیکس

ایک پلگ اِن ڈائریکٹری میں `package.json` شامل ہو سکتا ہے جس میں `openclaw.extensions` ہوں:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

اگر آپ کا پلگ اِن npm انحصارات امپورٹ کرتا ہے تو انہیں اسی ڈائریکٹری میں انسٹال کریں تاکہ
`node_modules` دستیاب ہو (`npm install` / `pnpm install`)۔

### چینل کیٹلاگ میٹاڈیٹا

Channel plugins can advertise onboarding metadata via `openclaw.channel` and
install hints via `openclaw.install`. This keeps the core catalog data-free.

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

OpenClaw can also merge **external channel catalogs** (for example, an MPM
registry export). Drop a JSON file at one of:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Or point `OPENCLAW_PLUGIN_CATALOG_PATHS` (or `OPENCLAW_MPM_CATALOG_PATHS`) at
one or more JSON files (comma/semicolon/`PATH`-delimited). Each file should
contain `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## پلگ اِن IDs

ڈیفالٹ پلگ اِن ids:

- پیکیج پیکس: `package.json` `name`
- اسٹینڈ الون فائل: فائل کا بیس نام (`~/.../voice-call.ts` → `voice-call`)

اگر کوئی پلگ اِن `id` ایکسپورٹ کرتا ہے تو OpenClaw اسے استعمال کرتا ہے لیکن
جب یہ کنفیگر شدہ id سے میل نہ کھائے تو وارننگ دیتا ہے۔

## کنفیگ

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

فیلڈز:

- `enabled`: ماسٹر ٹوگل (ڈیفالٹ: true)
- `allow`: اجازت فہرست (اختیاری)
- `deny`: منع فہرست (اختیاری؛ منع کو فوقیت)
- `load.paths`: اضافی پلگ اِن فائلیں/ڈائریکٹریز
- `entries.<id>`: per‑plugin toggles + config

کنفیگ میں تبدیلیوں کے لیے **gateway ری اسٹارٹ لازم** ہے۔

توثیقی قواعد (سخت):

- `entries`, `allow`, `deny`, یا `slots` میں نامعلوم پلگ اِن ids **غلطیاں** ہیں۔
- Unknown `channels.<id>` keys are **errors** unless a plugin manifest declares
  the channel id.
- پلگ اِن کنفیگ کی توثیق `openclaw.plugin.json` میں شامل JSON Schema کے ذریعے کی جاتی ہے (`configSchema`)۔
- اگر کوئی پلگ اِن غیرفعال ہو تو اس کی کنفیگ محفوظ رہتی ہے اور **وارننگ** جاری ہوتی ہے۔

## پلگ اِن سلاٹس (خصوصی زمرہ جات)

Some plugin categories are **exclusive** (only one active at a time). Use
`plugins.slots` to select which plugin owns the slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

If multiple plugins declare `kind: "memory"`, only the selected one loads. Others
are disabled with diagnostics.

## کنٹرول UI (اسکیما + لیبلز)

کنٹرول UI بہتر فارم رینڈر کرنے کے لیے `config.schema` (JSON Schema + `uiHints`) استعمال کرتا ہے۔

OpenClaw دریافت شدہ پلگ اِنز کی بنیاد پر رن ٹائم پر `uiHints` کو وسعت دیتا ہے:

- Adds per-plugin labels for `plugins.entries.<id>` / `.enabled` / `.config`
- Merges optional plugin-provided config field hints under:
  `plugins.entries.<id>.config.<field>`

اگر آپ چاہتے ہیں کہ آپ کے پلگ اِن کنفیگ فیلڈز اچھے لیبلز/پلیس ہولڈرز دکھائیں (اور رازدارانہ قدروں کو حساس کے طور پر نشان زد کریں)،
تو پلگ اِن مینِفیسٹ میں اپنے JSON Schema کے ساتھ `uiHints` فراہم کریں۔

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

`plugins update` صرف ان npm انسٹالز کے لیے کام کرتا ہے جو `plugins.installs` کے تحت ٹریک کیے جاتے ہیں۔

پلگ اِنز اپنی علیحدہ ٹاپ‑لیول کمانڈز بھی رجسٹر کر سکتے ہیں (مثال: `openclaw voicecall`)۔

## پلگ اِن API (جائزہ)

پلگ اِنز درج ذیل میں سے ایک ایکسپورٹ کرتے ہیں:

- ایک فنکشن: `(api) => { ... }`
- An object: `{ id, name, configSchema, register(api) { ... } }`

## پلگ اِن ہکس

پلگ اِنز ہُکس فراہم کر سکتے ہیں اور انہیں رن ٹائم پر رجسٹر کر سکتے ہیں۔ یہ ایک پلگ اِن بنڈل کو اجازت دیتا ہے کہ وہ
ایونٹ ڈرِوَن آٹومیشن کو بغیر علیحدہ ہُک پیک انسٹال کیے فراہم کرے۔

### مثال

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

نوٹس:

- ہک ڈائریکٹریز عام ہک اسٹرکچر کی پیروی کرتی ہیں (`HOOK.md` + `handler.ts`)۔
- ہک اہلیت کے قواعد بدستور لاگو رہتے ہیں (OS/bins/env/config تقاضے)۔
- پلگ اِن کے زیرِ انتظام ہکس `openclaw hooks list` میں `plugin:<id>` کے ساتھ دکھائی دیتے ہیں۔
- آپ `openclaw hooks` کے ذریعے پلگ اِن کے زیرِ انتظام ہکس کو فعال/غیرفعال نہیں کر سکتے؛ اس کے بجائے پلگ اِن کو فعال/غیرفعال کریں۔

## فراہم کنندہ پلگ اِنز (ماڈل auth)

پلگ اِنز **ماڈل فراہم کنندہ auth** فلو رجسٹر کر سکتے ہیں تاکہ صارفین OpenClaw کے اندر ہی OAuth یا
API‑کلید سیٹ اپ چلا سکیں (بیرونی اسکرپٹس کی ضرورت نہیں)۔

`api.registerProvider(...)` کے ذریعے ایک پرووائیڈر رجسٹر کریں۔ ہر پرووائیڈر ایک
یا ایک سے زیادہ تصدیقی طریقے فراہم کرتا ہے (OAuth، API key، device code، وغیرہ)۔ یہ طریقے درج ذیل کو طاقت دیتے ہیں:

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

نوٹس:

- `run` کو ایک `ProviderAuthContext` موصول ہوتا ہے جس میں `prompter`, `runtime`,
  `openUrl`, اور `oauth.createVpsAwareHandlers` ہیلپرز شامل ہوتے ہیں۔
- جب ڈیفالٹ ماڈلز یا فراہم کنندہ کنفیگ شامل کرنی ہو تو `configPatch` واپس کریں۔
- `defaultModel` واپس کریں تاکہ `--set-default` ایجنٹ ڈیفالٹس اپ ڈیٹ کر سکے۔

### میسجنگ چینل رجسٹر کریں

پلگ اِنز **چینل پلگ اِنز** رجسٹر کر سکتے ہیں جو بلٹ اِن چینلز کی طرح برتاؤ کرتے ہیں
(WhatsApp، Telegram، وغیرہ)۔ چینل کنفیگ `channels.<id>` کے تحت رہتی ہے\` اور آپ کے چینل پلگ اِن کوڈ کے ذریعے
ویلیڈیٹ کی جاتی ہے۔

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

نوٹس:

- Put config under `channels.<id>` (not `plugins.entries`).
- `meta.label` CLI/UI فہرستوں میں لیبلز کے لیے استعمال ہوتا ہے۔
- `meta.aliases` نارملائزیشن اور CLI ان پٹس کے لیے متبادل ids شامل کرتا ہے۔
- `meta.preferOver` ان چینل ids کی فہرست دیتا ہے جنہیں دونوں کنفیگر ہونے پر خودکار فعال ہونے سے بچانا ہو۔
- `meta.detailLabel` اور `meta.systemImage` UIs کو مزید بھرپور چینل لیبلز/آئیکنز دکھانے دیتے ہیں۔

### نیا میسجنگ چینل لکھیں (مرحلہ وار)

اسے اس وقت استعمال کریں جب آپ ایک **نئی چیٹ سطح** (ایک “میسجنگ چینل”) چاہتے ہوں، نہ کہ ماڈل پرووائیڈر۔
ماڈل پرووائیڈر کی دستاویزات `/providers/*` کے تحت موجود ہیں۔

1. id + کنفیگ شکل منتخب کریں

- تمام چینل کنفیگ `channels.<id>` کے تحت رہتی ہے\`۔
- ملٹی اکاؤنٹ سیٹ اپس کے لیے `channels.<id>` کو ترجیح دیں\`.accounts.<accountId>\`\`۔

2. چینل میٹاڈیٹا متعین کریں

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` CLI/UI فہرستوں کو کنٹرول کرتے ہیں۔
- `meta.docsPath` کو `/channels/<id>` جیسی دستاویز صفحے کی طرف اشارہ کرنا چاہیے۔
- `meta.preferOver` کسی دوسرے چینل کو تبدیل کرنے دیتا ہے (خودکار فعال میں ترجیح ملتی ہے)۔
- `meta.detailLabel` اور `meta.systemImage` تفصیلی متن/آئیکنز کے لیے UIs استعمال کرتے ہیں۔

3. مطلوبہ ایڈاپٹرز نافذ کریں

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (چیٹ اقسام، میڈیا، تھریڈز، وغیرہ)
- `outbound.deliveryMode` + `outbound.sendText` (بنیادی بھیجنے کے لیے)

4. ضرورت کے مطابق اختیاری ایڈاپٹرز شامل کریں

- `setup` (وزارڈ)، `security` (DM پالیسی)، `status` (صحت/تشخیص)
- `gateway` (اسٹارٹ/اسٹاپ/لاگ اِن)، `mentions`, `threading`, `streaming`
- `actions` (پیغام ایکشنز)، `commands` (نیٹو کمانڈ رویّہ)

5. اپنے پلگ اِن میں چینل رجسٹر کریں

- `api.registerChannel({ plugin })`

کم سے کم کنفیگ مثال:

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

کم سے کم چینل پلگ اِن (صرف آؤٹ باؤنڈ):

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

پلگ اِن لوڈ کریں (extensions ڈائریکٹری یا `plugins.load.paths`)، گیٹ وے ری اسٹارٹ کریں،
پھر اپنی کنفیگ میں \`channels.<id>\`\` کو کنفیگر کریں۔

### ایجنٹ اوزار

مخصوص رہنمائی دیکھیں: [Plugin agent tools](/plugins/agent-tools)۔

### Gateway RPC میتھڈ رجسٹر کریں

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### CLI کمانڈز رجسٹر کریں

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

### خودکار جواب کمانڈز رجسٹر کریں

پلگ اِنز کسٹم سلیش کمانڈز رجسٹر کر سکتے ہیں جو **AI ایجنٹ کو چلائے بغیر** ایکزیکیوٹ ہوتی ہیں۔ This is useful for toggle commands, status checks, or quick actions
that don't need LLM processing.

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

کمانڈ ہینڈلر کانٹیکسٹ:

- `senderId`: بھیجنے والے کی ID (اگر دستیاب ہو)
- `channel`: وہ چینل جہاں کمانڈ بھیجی گئی
- `isAuthorizedSender`: آیا بھیجنے والا مجاز صارف ہے
- `args`: کمانڈ کے بعد دیے گئے آرگیومنٹس (اگر `acceptsArgs: true`)
- `commandBody`: مکمل کمانڈ متن
- `config`: موجودہ OpenClaw کنفیگ

کمانڈ اختیارات:

- `name`: کمانڈ نام (ابتدائی `/` کے بغیر)
- `description`: کمانڈ فہرستوں میں دکھایا جانے والا مددگار متن
- `acceptsArgs`: آیا کمانڈ آرگیومنٹس قبول کرتی ہے یا نہیں (ڈیفالٹ: false)۔ اگر false ہو اور آرگیومنٹس فراہم کیے جائیں، تو کمانڈ میچ نہیں کرے گی اور پیغام دوسرے ہینڈلرز کو پاس ہو جائے گا۔
- `requireAuth`: آیا مجاز بھیجنے والا درکار ہے (ڈیفالٹ: true)
- `handler`: وہ فنکشن جو `{ text: string }` واپس کرتا ہے (async ہو سکتا ہے)

اختیار اور آرگیومنٹس کے ساتھ مثال:

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

نوٹس:

- پلگ اِن کمانڈز بلٹ‑اِن کمانڈز اور AI ایجنٹ سے **پہلے** پروسیس ہوتی ہیں
- کمانڈز عالمی طور پر رجسٹر ہوتی ہیں اور تمام چینلز میں کام کرتی ہیں
- کمانڈ نام کیس‑انسینسیٹو ہوتے ہیں (`/MyStatus`، `/mystatus` سے میچ کرتا ہے)
- کمانڈ نام کسی حرف سے شروع ہونا چاہیے اور صرف حروف، اعداد، ہائفن، اور انڈر اسکور پر مشتمل ہو سکتا ہے
- محفوظ کمانڈ نام (جیسے `help`، `status`، `reset`، وغیرہ) پلگ اِنز کے ذریعے اووررائیڈ نہیں کیے جا سکتے۔
- پلگ اِنز کے درمیان کمانڈ کی دوہری رجسٹریشن تشخیصی غلطی کے ساتھ ناکام ہو جائے گی

### بیک گراؤنڈ سروسز رجسٹر کریں

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## نام رکھنے کے ضوابط

- Gateway میتھڈز: `pluginId.action` (مثال: `voicecall.status`)
- اوزار: `snake_case` (مثال: `voice_call`)
- CLI کمانڈز: kebab یا camel، لیکن کور کمانڈز سے ٹکراؤ سے بچیں

## Skills

پلگ اِنز ریپو میں ایک اسکل فراہم کر سکتے ہیں (`skills/<name>/SKILL.md`)۔
Enable it with `plugins.entries.<id>.enabled` (or other config gates) and ensure
it’s present in your workspace/managed skills locations.

## تقسیم (npm)

سفارش کردہ پیکیجنگ:

- مین پیکیج: `openclaw` (یہ ریپو)
- پلگ اِنز: `@openclaw/*` کے تحت علیحدہ npm پیکیجز (مثال: `@openclaw/voice-call`)

اشاعت کا معاہدہ:

- پلگ اِن `package.json` میں ایک یا زیادہ انٹری فائلز کے ساتھ `openclaw.extensions` شامل ہونا چاہیے۔
- انٹری فائلز `.js` یا `.ts` ہو سکتی ہیں (jiti رن ٹائم پر TS لوڈ کرتا ہے)۔
- `openclaw plugins install <npm-spec>` `npm pack` استعمال کرتا ہے، `~/.openclaw/extensions/<id>/` میں ایکسٹریکٹ کرتا ہے، اور کنفیگ میں فعال کرتا ہے۔
- کنفیگ کلید کا استحکام: اسکوپڈ پیکیجز کو `plugins.entries.*` کے لیے **غیر اسکوپڈ** id میں نارملائز کیا جاتا ہے۔

## مثال پلگ اِن: Voice Call

یہ ریپو ایک وائس‑کال پلگ اِن شامل کرتا ہے (Twilio یا لاگ فال بیک):

- سورس: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- اوزار: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- کنفیگ (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (اختیاری `statusCallbackUrl`, `twimlUrl`)
- کنفیگ (dev): `provider: "log"` (بلا نیٹ ورک)

سیٹ اپ اور استعمال کے لیے [Voice Call](/plugins/voice-call) اور `extensions/voice-call/README.md` دیکھیں۔

## حفاظتی نوٹس

پلگ اِنز گیٹ وے کے ساتھ اِن-پروسیس چلتے ہیں۔ انہیں قابلِ اعتماد کوڈ سمجھیں:

- صرف وہی پلگ اِنز انسٹال کریں جن پر آپ کو اعتماد ہو۔
- `plugins.allow` اجازت فہرستوں کو ترجیح دیں۔
- تبدیلیوں کے بعد Gateway ری اسٹارٹ کریں۔

## پلگ اِنز کی جانچ

پلگ اِنز ٹیسٹس کے ساتھ آ سکتے ہیں (اور آنا چاہیے):

- ریپو کے اندر موجود پلگ اِنز Vitest ٹیسٹس `src/**` کے تحت رکھ سکتے ہیں (مثال: `src/plugins/voice-call.plugin.test.ts`)۔
- علیحدہ شائع شدہ پلگ اِنز کو اپنی CI (lint/build/test) چلانی چاہیے اور یہ توثیق کرنی چاہیے کہ `openclaw.extensions` بلٹ انٹری پوائنٹ (`dist/index.js`) کی طرف اشارہ کرتا ہے۔
