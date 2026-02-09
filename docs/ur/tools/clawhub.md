---
summary: "ClawHub گائیڈ: عوامی Skills رجسٹری + CLI ورک فلو"
read_when:
  - نئے صارفین کو ClawHub متعارف کراتے وقت
  - Skills انسٹال کرنے، تلاش کرنے، یا شائع کرنے کے لیے
  - ClawHub CLI فلیگز اور سنک رویّے کی وضاحت کے لیے
title: "ClawHub"
---

# ClawHub

ClawHub is the **public skill registry for OpenClaw**. It is a free service: all skills are public, open, and visible to everyone for sharing and reuse. A skill is just a folder with a `SKILL.md` file (plus supporting text files). You can browse skills in the web app or use the CLI to search, install, update, and publish skills.

سائٹ: [clawhub.ai](https://clawhub.ai)

## ClawHub کیا ہے

- OpenClaw Skills کے لیے ایک عوامی رجسٹری۔
- Skills بنڈلز اور میٹا ڈیٹا کا ورژن شدہ ذخیرہ۔
- تلاش، ٹیگز، اور استعمالی سگنلز کے لیے ایک ڈسکوری سطح۔

## یہ کیسے کام کرتا ہے

1. ایک صارف Skill بنڈل (فائلیں + میٹا ڈیٹا) شائع کرتا ہے۔
2. ClawHub بنڈل کو محفوظ کرتا ہے، میٹا ڈیٹا پارس کرتا ہے، اور ایک ورژن تفویض کرتا ہے۔
3. رجسٹری Skill کو تلاش اور ڈسکوری کے لیے انڈیکس کرتی ہے۔
4. صارفین Skills براؤز، ڈاؤن لوڈ، اور OpenClaw میں انسٹال کرتے ہیں۔

## آپ کیا کر سکتے ہیں

- نئی Skills اور موجودہ Skills کے نئے ورژنز شائع کرنا۔
- نام، ٹیگز، یا تلاش کے ذریعے Skills دریافت کرنا۔
- Skill بنڈلز ڈاؤن لوڈ کرنا اور ان کی فائلیں دیکھنا۔
- بدسلوکی یا غیر محفوظ Skills کی رپورٹ کرنا۔
- اگر آپ موڈریٹر ہیں تو چھپانا، ظاہر کرنا، حذف کرنا، یا پابندی لگانا۔

## یہ کس کے لیے ہے (مبتدی دوست)

If you want to add new capabilities to your OpenClaw agent, ClawHub is the easiest way to find and install skills. You do not need to know how the backend works. You can:

- سادہ زبان میں Skills تلاش کرنا۔
- ایک Skill کو اپنے ورک اسپیس میں انسٹال کرنا۔
- ایک کمانڈ سے بعد میں Skills اپڈیٹ کرنا۔
- اپنی Skills شائع کر کے بیک اپ بنانا۔

## فوری آغاز (غیر تکنیکی)

1. CLI انسٹال کریں (اگلا سیکشن دیکھیں)۔
2. جس چیز کی ضرورت ہو اسے تلاش کریں:
   - `clawhub search "calendar"`
3. ایک Skill انسٹال کریں:
   - `clawhub install <skill-slug>`
4. ایک نیا OpenClaw سیشن شروع کریں تاکہ نئی Skill لوڈ ہو جائے۔

## CLI انسٹال کریں

ان میں سے ایک منتخب کریں:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## OpenClaw میں اس کی جگہ

By default, the CLI installs skills into `./skills` under your current working directory. If a OpenClaw workspace is configured, `clawhub` falls back to that workspace unless you override `--workdir` (or `CLAWHUB_WORKDIR`). OpenClaw loads workspace skills from `<workspace>/skills` and will pick them up in the **next** session. If you already use `~/.openclaw/skills` or bundled skills, workspace skills take precedence.

Skills کے لوڈ ہونے، شیئر ہونے، اور گیٹنگ کی مزید تفصیل کے لیے دیکھیں:
[Skills](/tools/skills)

## Skill سسٹم کا جائزہ

A skill is a versioned bundle of files that teaches OpenClaw how to perform a
specific task. Each publish creates a new version, and the registry keeps a
history of versions so users can audit changes.

ایک عام Skill میں شامل ہوتا ہے:

- بنیادی وضاحت اور استعمال کے ساتھ ایک `SKILL.md` فائل۔
- اختیاری کنفیگز، اسکرپٹس، یا معاون فائلیں جو Skill استعمال کرتی ہے۔
- ٹیگز، خلاصہ، اور انسٹال کی ضروریات جیسا میٹا ڈیٹا۔

ClawHub uses metadata to power discovery and safely expose skill capabilities.
The registry also tracks usage signals (such as stars and downloads) to improve
ranking and visibility.

## سروس کیا فراہم کرتی ہے (خصوصیات)

- Skills اور ان کے `SKILL.md` مواد کی **عوامی براؤزنگ**۔
- **تلاش** جو ایمبیڈنگز (ویکٹر سرچ) سے تقویت یافتہ ہے، صرف کی ورڈز نہیں۔
- **ورژننگ** مع semver، چینج لاگز، اور ٹیگز (بشمول `latest`)۔
- **ڈاؤن لوڈز** ہر ورژن کے لیے بطور zip۔
- **اسٹارز اور تبصرے** کمیونٹی فیڈ بیک کے لیے۔
- **موڈریشن** منظوریوں اور آڈٹس کے لیے ہکس۔
- **CLI دوست API** آٹومیشن اور اسکرپٹنگ کے لیے۔

## سکیورٹی اور موڈریشن

ClawHub is open by default. Anyone can upload skills, but a GitHub account must
be at least one week old to publish. This helps slow down abuse without blocking
legitimate contributors.

رپورٹنگ اور موڈریشن:

- کوئی بھی سائن اِن صارف Skill کی رپورٹ کر سکتا ہے۔
- رپورٹ کی وجوہات لازمی ہیں اور ریکارڈ کی جاتی ہیں۔
- ہر صارف ایک وقت میں زیادہ سے زیادہ 20 فعال رپورٹس رکھ سکتا ہے۔
- 3 سے زیادہ منفرد رپورٹس والی Skills بطورِ طے شدہ خودکار طور پر چھپ جاتی ہیں۔
- موڈریٹرز چھپی ہوئی Skills دیکھ سکتے ہیں، انہیں ظاہر کر سکتے ہیں، حذف کر سکتے ہیں، یا صارفین پر پابندی لگا سکتے ہیں۔
- رپورٹ فیچر کا غلط استعمال اکاؤنٹ پابندیوں کا باعث بن سکتا ہے۔

Interested in becoming a moderator? Ask in the OpenClaw Discord and contact a
moderator or maintainer.

## CLI کمانڈز اور پیرامیٹرز

عالمی اختیارات (تمام کمانڈز پر لاگو):

- `--workdir <dir>`: ورکنگ ڈائریکٹری (بطورِ طے شدہ: موجودہ ڈائریکٹری؛ OpenClaw ورک اسپیس پر واپس جاتی ہے)۔
- `--dir <dir>`: Skills ڈائریکٹری، workdir کے نسبت سے (بطورِ طے شدہ: `skills`)۔
- `--site <url>`: سائٹ بیس URL (براؤزر لاگ اِن)۔
- `--registry <url>`: رجسٹری API بیس URL۔
- `--no-input`: پرامپٹس غیر فعال کریں (نان اِنٹریکٹو)۔
- `-V, --cli-version`: CLI ورژن پرنٹ کریں۔

تصدیق:

- `clawhub login` (براؤزر فلو) یا `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

اختیارات:

- `--token <token>`: API ٹوکن پیسٹ کریں۔
- `--label <label>`: براؤزر لاگ اِن ٹوکنز کے لیے محفوظ لیبل (بطورِ طے شدہ: `CLI token`)۔
- `--no-browser`: براؤزر نہ کھولیں (درکار: `--token`)۔

تلاش:

- `clawhub search "query"`
- `--limit <n>`: زیادہ سے زیادہ نتائج۔

انسٹال:

- `clawhub install <slug>`
- `--version <version>`: مخصوص ورژن انسٹال کریں۔
- `--force`: اگر فولڈر پہلے سے موجود ہو تو اوور رائٹ کریں۔

اپڈیٹ:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: مخصوص ورژن تک اپڈیٹ کریں (صرف ایک سلاگ)۔
- `--force`: جب مقامی فائلیں کسی شائع شدہ ورژن سے میچ نہ کریں تو اوور رائٹ کریں۔

فہرست:

- `clawhub list` (`.clawhub/lock.json` پڑھتا ہے)

شائع کریں:

- `clawhub publish <path>`
- `--slug <slug>`: Skill سلاگ۔
- `--name <name>`: ڈسپلے نام۔
- `--version <version>`: Semver ورژن۔
- `--changelog <text>`: چینج لاگ متن (خالی ہو سکتا ہے)۔
- `--tags <tags>`: کاما سے جدا ٹیگز (بطورِ طے شدہ: `latest`)۔

حذف/غیر حذف (صرف مالک/ایڈمن):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

سنک (مقامی Skills اسکین + نئی/اپڈیٹڈ شائع):

- `clawhub sync`
- `--root <dir...>`: اضافی اسکین روٹس۔
- `--all`: بغیر پرامپٹس سب کچھ اپلوڈ کریں۔
- `--dry-run`: دکھائیں کہ کیا اپلوڈ ہوگا۔
- `--bump <type>`: اپڈیٹس کے لیے `patch|minor|major` (بطورِ طے شدہ: `patch`)۔
- `--changelog <text>`: نان اِنٹریکٹو اپڈیٹس کے لیے چینج لاگ۔
- `--tags <tags>`: کاما سے جدا ٹیگز (بطورِ طے شدہ: `latest`)۔
- `--concurrency <n>`: رجسٹری چیکس (بطورِ طے شدہ: 4)۔

## ایجنٹس کے لیے عام ورک فلو

### Skills تلاش کریں

```bash
clawhub search "postgres backups"
```

### نئی Skills ڈاؤن لوڈ کریں

```bash
clawhub install my-skill-pack
```

### انسٹال شدہ Skills اپڈیٹ کریں

```bash
clawhub update --all
```

### اپنی Skills کا بیک اپ (شائع کریں یا سنک)

ایک واحد Skill فولڈر کے لیے:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

ایک ساتھ کئی Skills اسکین اور بیک اپ کرنے کے لیے:

```bash
clawhub sync --all
```

## اعلیٰ درجے کی تفصیلات (تکنیکی)

### ورژننگ اور ٹیگز

- ہر شائع کاری ایک نیا **semver** `SkillVersion` بناتی ہے۔
- ٹیگز (جیسے `latest`) کسی ورژن کی طرف اشارہ کرتے ہیں؛ ٹیگز کو منتقل کر کے آپ رول بیک کر سکتے ہیں۔
- چینج لاگز ہر ورژن کے ساتھ منسلک ہوتے ہیں اور سنک یا اپڈیٹس شائع کرتے وقت خالی ہو سکتے ہیں۔

### مقامی تبدیلیاں بمقابلہ رجسٹری ورژنز

Updates compare the local skill contents to registry versions using a content hash. If local files do not match any published version, the CLI asks before overwriting (or requires `--force` in non-interactive runs).

### سنک اسکیننگ اور فال بیک روٹس

`clawhub sync` scans your current workdir first. If no skills are found, it falls back to known legacy locations (for example `~/openclaw/skills` and `~/.openclaw/skills`). This is designed to find older skill installs without extra flags.

### اسٹوریج اور لاک فائل

- انسٹال شدہ Skills آپ کی workdir کے تحت `.clawhub/lock.json` میں ریکارڈ ہوتی ہیں۔
- تصدیقی ٹوکنز ClawHub CLI کنفیگ فائل میں محفوظ ہوتے ہیں (اوور رائڈ کریں بذریعہ `CLAWHUB_CONFIG_PATH`)۔

### ٹیلی میٹری (انسٹال کاؤنٹس)

When you run `clawhub sync` while logged in, the CLI sends a minimal snapshot to compute install counts. You can disable this entirely:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## ماحولیاتی متغیرات

- `CLAWHUB_SITE`: سائٹ URL اوور رائڈ کریں۔
- `CLAWHUB_REGISTRY`: رجسٹری API URL اوور رائڈ کریں۔
- `CLAWHUB_CONFIG_PATH`: CLI ٹوکن/کنفیگ کہاں محفوظ کرے اسے اوور رائڈ کریں۔
- `CLAWHUB_WORKDIR`: ڈیفالٹ workdir اوور رائڈ کریں۔
- `CLAWHUB_DISABLE_TELEMETRY=1`: `sync` پر ٹیلی میٹری غیر فعال کریں۔
