---
summary: "Skills: منظم بمقابلہ ورک اسپیس، گیٹنگ قواعد، اور کنفیگ/ماحولیاتی وائرنگ"
read_when:
  - Skills شامل یا ترمیم کرتے وقت
  - Skill گیٹنگ یا لوڈ قواعد تبدیل کرتے وقت
title: "Skills"
x-i18n:
  source_path: tools/skills.md
  source_hash: 70d7eb9e422c17a4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:21Z
---

# Skills (OpenClaw)

OpenClaw ایجنٹ کو اوزار استعمال کرنا سکھانے کے لیے **[AgentSkills](https://agentskills.io)-compatible** skill فولڈرز استعمال کرتا ہے۔ ہر skill ایک ڈائریکٹری ہوتی ہے جس میں YAML فرنٹ میٹر اور ہدایات کے ساتھ ایک `SKILL.md` شامل ہوتا ہے۔ OpenClaw **bundled skills** کے ساتھ اختیاری مقامی overrides لوڈ کرتا ہے، اور ماحول، کنفیگ، اور بائنری کی موجودگی کی بنیاد پر لوڈ ٹائم پر انہیں فلٹر کرتا ہے۔

## مقامات اور ترجیح

Skills **تین** جگہوں سے لوڈ کی جاتی ہیں:

1. **Bundled skills**: انسٹال کے ساتھ فراہم کی جاتی ہیں (npm پیکیج یا OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

اگر کسی skill کے نام میں ٹکراؤ ہو تو ترجیح یوں ہے:

`<workspace>/skills` (اعلیٰ ترین) → `~/.openclaw/skills` → bundled skills (کم ترین)

مزید یہ کہ، آپ اضافی skill فولڈرز (کم ترین ترجیح) کنفیگر کر سکتے ہیں بذریعہ
`skills.load.extraDirs` در `~/.openclaw/openclaw.json`۔

## فی ایجنٹ بمقابلہ مشترکہ skills

**ملٹی ایجنٹ** سیٹ اپس میں، ہر ایجنٹ کی اپنی ورک اسپیس ہوتی ہے۔ اس کا مطلب ہے:

- **فی ایجنٹ skills** اس ایجنٹ کے لیے صرف `<workspace>/skills` میں ہوتی ہیں۔
- **مشترکہ skills** `~/.openclaw/skills` (managed/local) میں ہوتی ہیں اور
  اسی مشین پر موجود **تمام ایجنٹس** کو نظر آتی ہیں۔
- **مشترکہ فولڈرز** بھی `skills.load.extraDirs` کے ذریعے شامل کیے جا سکتے ہیں (کم ترین
  ترجیح) اگر آپ متعدد ایجنٹس کے لیے ایک مشترکہ skills پیک استعمال کرنا چاہتے ہوں۔

اگر ایک ہی skill نام ایک سے زیادہ جگہوں پر موجود ہو تو معمول کی ترجیح
لاگو ہوتی ہے: ورک اسپیس جیتتی ہے، پھر managed/local، پھر bundled۔

## Plugins + skills

Plugins اپنی skills فراہم کر سکتے ہیں، `skills` ڈائریکٹریز کو
`openclaw.plugin.json` میں فہرست کر کے (راستے plugin روٹ کے نسبتاً ہوتے ہیں)۔ Plugin skills
plugin کے فعال ہونے پر لوڈ ہوتی ہیں اور عام skill ترجیحی قواعد میں شامل ہوتی ہیں۔
آپ انہیں plugin کی کنفیگ انٹری پر `metadata.openclaw.requires.config` کے ذریعے گیٹ کر سکتے ہیں۔
دریافت/کنفیگ کے لیے [Plugins](/tools/plugin) اور اُن اوزاروں کی سطح کے لیے [Tools](/tools) دیکھیں
جنہیں یہ skills سکھاتی ہیں۔

## ClawHub (انسٹال + ہم آہنگی)

ClawHub OpenClaw کے لیے عوامی skills رجسٹری ہے۔ ملاحظہ کریں
[https://clawhub.com](https://clawhub.com)۔ اسے skills دریافت کرنے، انسٹال کرنے، اپڈیٹ کرنے، اور بیک اپ کے لیے استعمال کریں۔
مکمل رہنمائی: [ClawHub](/tools/clawhub)۔

عام طریقۂ کار:

- اپنی ورک اسپیس میں کوئی skill انسٹال کریں:
  - `clawhub install <skill-slug>`
- تمام انسٹال شدہ skills اپڈیٹ کریں:
  - `clawhub update --all`
- Sync (اسکین + اپڈیٹس شائع کریں):
  - `clawhub sync --all`

بطورِ طے شدہ، `clawhub` آپ کی موجودہ ورکنگ ڈائریکٹری کے تحت `./skills` میں انسٹال کرتا ہے
(یا کنفیگر کی گئی OpenClaw ورک اسپیس پر واپس جاتا ہے)۔ OpenClaw اگلے سیشن پر
اسے `<workspace>/skills` کے طور پر پکڑ لیتا ہے۔

## سکیورٹی نوٹس

- تھرڈ پارٹی skills کو **غیر معتبر کوڈ** سمجھیں۔ فعال کرنے سے پہلے پڑھیں۔
- غیر معتبر اِن پٹس اور خطرناک اوزاروں کے لیے sandboxed رنز کو ترجیح دیں۔ دیکھیں [Sandboxing](/gateway/sandboxing)۔
- `skills.entries.*.env` اور `skills.entries.*.apiKey` اس ایجنٹ ٹرن کے لیے **ہوسٹ** پروسیس میں
  راز داخل کرتے ہیں (sandbox میں نہیں)۔ رازوں کو prompts اور logs سے باہر رکھیں۔
- وسیع تر threat ماڈل اور چیک لسٹس کے لیے [Security](/gateway/security) دیکھیں۔

## فارمیٹ (AgentSkills + Pi-compatible)

`SKILL.md` میں کم از کم یہ شامل ہونا چاہیے:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

نوٹس:

- لے آؤٹ/انٹینٹ کے لیے ہم AgentSkills اسپیک کی پیروی کرتے ہیں۔
- ایمبیڈڈ ایجنٹ کے ذریعے استعمال ہونے والا parser صرف **سنگل لائن** فرنٹ میٹر کیز کو سپورٹ کرتا ہے۔
- `metadata` ایک **سنگل لائن JSON آبجیکٹ** ہونا چاہیے۔
- ہدایات میں skill فولڈر کے راستے کا حوالہ دینے کے لیے `{baseDir}` استعمال کریں۔
- اختیاری فرنٹ میٹر کیز:
  - `homepage` — URL جو macOS Skills UI میں “Website” کے طور پر دکھایا جاتا ہے ( `metadata.openclaw.homepage` کے ذریعے بھی سپورٹڈ)۔
  - `user-invocable` — `true|false` (بطورِ طے شدہ: `true`)۔ جب `true` ہو تو skill صارف slash کمانڈ کے طور پر ظاہر ہوتی ہے۔
  - `disable-model-invocation` — `true|false` (بطورِ طے شدہ: `false`)۔ جب `true` ہو تو skill ماڈل prompt سے خارج کر دی جاتی ہے (تاہم صارف invocation کے ذریعے دستیاب رہتی ہے)۔
  - `command-dispatch` — `tool` (اختیاری)۔ جب `tool` پر سیٹ ہو تو slash کمانڈ ماڈل کو بائی پاس کر کے براہِ راست کسی tool کو ڈسپیچ کرتی ہے۔
  - `command-tool` — وہ tool نام جسے invoke کیا جائے جب `command-dispatch: tool` سیٹ ہو۔
  - `command-arg-mode` — `raw` (بطورِ طے شدہ)۔ tool ڈسپیچ کے لیے خام args اسٹرنگ کو tool تک فارورڈ کرتا ہے (بغیر core parsing کے)۔

    tool کو ان params کے ساتھ invoke کیا جاتا ہے:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`۔

## گیٹنگ (لوڈ ٹائم فلٹرز)

OpenClaw **لوڈ ٹائم پر skills کو فلٹر کرتا ہے** بذریعہ `metadata` (سنگل لائن JSON):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

`metadata.openclaw` کے تحت فیلڈز:

- `always: true` — ہمیشہ skill شامل کریں (دیگر گیٹس کو اسکیپ کریں)۔
- `emoji` — اختیاری ایموجی جو macOS Skills UI میں استعمال ہوتی ہے۔
- `homepage` — اختیاری URL جو macOS Skills UI میں “Website” کے طور پر دکھایا جاتا ہے۔
- `os` — پلیٹ فارمز کی اختیاری فہرست (`darwin`, `linux`, `win32`)۔ اگر سیٹ ہو تو skill صرف انہی OSes پر اہل ہوگی۔
- `requires.bins` — فہرست؛ ہر ایک کا `PATH` پر موجود ہونا لازم ہے۔
- `requires.anyBins` — فہرست؛ کم از کم ایک کا `PATH` پر موجود ہونا ضروری ہے۔
- `requires.env` — فہرست؛ env var کا موجود ہونا **یا** کنفیگ میں فراہم ہونا لازم ہے۔
- `requires.config` — `openclaw.json` راستوں کی فہرست جو truthy ہونے چاہئیں۔
- `primaryEnv` — env var نام جو `skills.entries.<name>.apiKey` سے وابستہ ہے۔
- `install` — macOS Skills UI میں استعمال ہونے والی installer specs کی اختیاری array (brew/node/go/uv/download)۔

sandboxing پر نوٹ:

- `requires.bins` کو skill لوڈ ٹائم پر **ہوسٹ** پر چیک کیا جاتا ہے۔
- اگر ایجنٹ sandboxed ہو تو بائنری کو **کنٹینر کے اندر** بھی موجود ہونا چاہیے۔
  اسے `agents.defaults.sandbox.docker.setupCommand` کے ذریعے انسٹال کریں (یا custom image استعمال کریں)۔
  `setupCommand` کنٹینر بننے کے بعد ایک بار چلتا ہے۔
  پیکیج انسٹالز کے لیے نیٹ ورک egress، قابلِ تحریر root FS، اور sandbox میں root صارف بھی درکار ہوتا ہے۔
  مثال: `summarize` skill (`skills/summarize/SKILL.md`) کو sandbox کنٹینر میں چلانے کے لیے
  `summarize` CLI درکار ہے۔

Installer مثال:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

نوٹس:

- اگر متعدد installers درج ہوں تو gateway **ایک** ترجیحی آپشن منتخب کرتا ہے (جب دستیاب ہو تو brew، ورنہ node)۔
- اگر تمام installers `download` ہوں تو OpenClaw ہر انٹری کی فہرست دکھاتا ہے تاکہ دستیاب artifacts نظر آ سکیں۔
- Installer specs میں پلیٹ فارم کے مطابق فلٹر کرنے کے لیے `os: ["darwin"|"linux"|"win32"]` شامل ہو سکتا ہے۔
- Node installs، `openclaw.json` میں `skills.install.nodeManager` کی پابندی کرتے ہیں (بطورِ طے شدہ: npm؛ اختیارات: npm/pnpm/yarn/bun)۔
  یہ صرف **skill installs** کو متاثر کرتا ہے؛ Gateway runtime پھر بھی Node ہونا چاہیے
  (WhatsApp/Telegram کے لیے Bun کی سفارش نہیں کی جاتی)۔
- Go installs: اگر `go` غائب ہو اور `brew` دستیاب ہو تو gateway پہلے Homebrew کے ذریعے Go انسٹال کرتا ہے اور جہاں ممکن ہو `GOBIN` کو Homebrew کے `bin` پر سیٹ کرتا ہے۔
- Download installs: `url` (لازم)، `archive` (`tar.gz` | `tar.bz2` | `zip`)، `extract` (بطورِ طے شدہ: archive شناخت ہونے پر auto)، `stripComponents`، `targetDir` (بطورِ طے شدہ: `~/.openclaw/tools/<skillKey>`)۔

اگر کوئی `metadata.openclaw` موجود نہ ہو تو skill ہمیشہ اہل ہوتی ہے (الا یہ کہ
کنفیگ میں غیرفعال کی گئی ہو یا bundled skills کے لیے `skills.allowBundled` کے ذریعے بلاک ہو)۔

## کنفیگ overrides (`~/.openclaw/openclaw.json`)

Bundled/managed skills کو ٹوگل کیا جا سکتا ہے اور env ویلیوز فراہم کی جا سکتی ہیں:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

نوٹ: اگر skill کے نام میں hyphens ہوں تو key کو کوٹ کریں (JSON5 کوٹڈ keys کی اجازت دیتا ہے)۔

کنفیگ keys بطورِ طے شدہ **skill نام** سے میچ کرتی ہیں۔ اگر کوئی skill
`metadata.openclaw.skillKey` متعین کرے تو `skills.entries` کے تحت وہی key استعمال کریں۔

قواعد:

- `enabled: false` skill کو غیر فعال کر دیتا ہے چاہے وہ bundled/installed ہو۔
- `env`: **صرف اسی صورت** inject ہوتا ہے جب ویری ایبل پہلے سے پروسیس میں سیٹ نہ ہو۔
- `apiKey`: اُن skills کے لیے سہولت جو `metadata.openclaw.primaryEnv` کا اعلان کرتی ہیں۔
- `config`: custom فی-skill فیلڈز کے لیے اختیاری bag؛ custom keys لازماً یہیں ہوں۔
- `allowBundled`: **صرف bundled** skills کے لیے اختیاری allowlist۔ اگر سیٹ ہو تو
  فہرست میں شامل bundled skills ہی اہل ہوں گی (managed/workspace skills متاثر نہیں ہوتیں)۔

## ماحول کی انجیکشن (ہر ایجنٹ رن کے لیے)

جب ایجنٹ رن شروع ہوتا ہے تو OpenClaw:

1. skill میٹاڈیٹا پڑھتا ہے۔
2. کسی بھی `skills.entries.<key>.env` یا `skills.entries.<key>.apiKey` کو
   `process.env` پر لاگو کرتا ہے۔
3. **اہل** skills کے ساتھ سسٹم prompt بناتا ہے۔
4. رن ختم ہونے کے بعد اصل ماحول بحال کر دیتا ہے۔

یہ **ایجنٹ رن تک محدود** ہے، کوئی عالمی شیل ماحول نہیں۔

## سیشن اسنیپ شاٹ (کارکردگی)

OpenClaw سیشن شروع ہونے پر **اہل skills** کا اسنیپ شاٹ لیتا ہے اور اسی سیشن کے بعد کے ٹرنز میں وہی فہرست دوبارہ استعمال کرتا ہے۔ skills یا کنفیگ میں تبدیلیاں اگلے نئے سیشن پر نافذ ہوتی ہیں۔

Skills مڈ-سیشن بھی ریفریش ہو سکتی ہیں جب skills watcher فعال ہو یا جب کوئی نیا اہل ریموٹ نوڈ ظاہر ہو (نیچے دیکھیں)۔ اسے **hot reload** سمجھیں: ریفریش شدہ فہرست اگلے ایجنٹ ٹرن پر لاگو ہو جاتی ہے۔

## ریموٹ macOS نوڈز (Linux gateway)

اگر Gateway Linux پر چل رہا ہو مگر ایک **macOS نوڈ** منسلک ہو **اور `system.run` کی اجازت ہو** (Exec approvals سکیورٹی `deny` پر سیٹ نہ ہو)، تو OpenClaw macOS-only skills کو اہل سمجھ سکتا ہے بشرطیکہ مطلوبہ بائنریز اس نوڈ پر موجود ہوں۔ ایجنٹ کو چاہیے کہ ان skills کو `nodes` tool کے ذریعے execute کرے (عموماً `nodes.run`)۔

یہ نوڈ کی جانب سے اپنی کمانڈ سپورٹ رپورٹ کرنے اور `system.run` کے ذریعے bin probe پر انحصار کرتا ہے۔ اگر macOS نوڈ بعد میں آف لائن ہو جائے تو skills نظر آتی رہیں گی؛ invocation نوڈ کے دوبارہ منسلک ہونے تک ناکام ہو سکتی ہے۔

## Skills watcher (خودکار ریفریش)

بطورِ طے شدہ، OpenClaw skill فولڈرز کو واچ کرتا ہے اور جب `SKILL.md` فائلیں بدلتی ہیں تو skills اسنیپ شاٹ بڑھا دیتا ہے۔ اسے `skills.load` کے تحت کنفیگر کریں:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## ٹوکن اثر (skills فہرست)

جب skills اہل ہوتی ہیں تو OpenClaw دستیاب skills کی ایک مختصر XML فہرست سسٹم prompt میں inject کرتا ہے (`pi-coding-agent` میں `formatSkillsForPrompt` کے ذریعے)۔ لاگت متعین ہوتی ہے:

- **بنیادی اوورہیڈ (صرف جب ≥1 skill ہو):** 195 حروف۔
- **فی skill:** 97 حروف + XML-escaped `<name>`, `<description>`, اور `<location>` ویلیوز کی لمبائی۔

فارمولا (حروف):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

نوٹس:

- XML escaping، `& < > " '` کو entities (`&amp;`, `&lt;`, وغیرہ) میں پھیلا دیتا ہے، جس سے لمبائی بڑھتی ہے۔
- ٹوکن کی گنتی ماڈل tokenizer کے مطابق بدلتی ہے۔ OpenAI طرز کے اندازے کے مطابق ~4 حروف/ٹوکن، اس لیے **97 حروف ≈ 24 ٹوکن** فی skill، اس کے علاوہ آپ کے اصل فیلڈ کی لمبائیاں۔

## Managed skills لائف سائیکل

OpenClaw انسٹال کے حصے کے طور پر **bundled skills** کی ایک بنیادی سیٹ فراہم کرتا ہے
(npm پیکیج یا OpenClaw.app)۔ `~/.openclaw/skills` مقامی overrides کے لیے موجود ہے
(مثلاً bundled کاپی بدلے بغیر کسی skill کو pin/patch کرنا)۔ Workspace skills صارف کی ملکیت ہوتی ہیں اور نام کے ٹکراؤ پر دونوں کو override کر دیتی ہیں۔

## کنفیگ حوالہ

مکمل کنفیگریشن اسکیمہ کے لیے [Skills config](/tools/skills-config) دیکھیں۔

## مزید skills تلاش کر رہے ہیں؟

ملاحظہ کریں [https://clawhub.com](https://clawhub.com)۔

---
