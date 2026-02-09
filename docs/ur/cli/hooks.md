---
summary: "`openclaw hooks` کے لیے CLI حوالہ (ایجنٹ ہکس)"
read_when:
  - آپ ایجنٹ ہکس کا نظم کرنا چاہتے ہیں
  - آپ ہکس انسٹال یا اپڈیٹ کرنا چاہتے ہیں
title: "hooks"
---

# `openclaw hooks`

ایجنٹ ہکس کا نظم کریں (کمانڈز جیسے `/new`، `/reset`، اور gateway کے آغاز کے لیے ایونٹ پر مبنی آٹومیشنز)۔

متعلقہ:

- Hooks: [Hooks](/automation/hooks)
- Plugin hooks: [Plugins](/tools/plugin#plugin-hooks)

## تمام ہکس کی فہرست

```bash
openclaw hooks list
```

ورک اسپیس، مینیجڈ، اور بنڈلڈ ڈائریکٹریز سے دریافت شدہ تمام ہکس کی فہرست دکھائیں۔

**اختیارات:**

- `--eligible`: صرف اہل ہکس دکھائیں (ضروریات پوری ہوں)
- `--json`: JSON کے طور پر آؤٹ پٹ
- `-v, --verbose`: گمشدہ ضروریات سمیت تفصیلی معلومات دکھائیں

**مثالی آؤٹ پٹ:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**مثال (تفصیلی):**

```bash
openclaw hooks list --verbose
```

نااہل ہکس کے لیے گمشدہ ضروریات دکھاتا ہے۔

**مثال (JSON):**

```bash
openclaw hooks list --json
```

پروگراماتی استعمال کے لیے ساختی JSON واپس کرتا ہے۔

## ہک کی معلومات حاصل کریں

```bash
openclaw hooks info <name>
```

کسی مخصوص ہک کے بارے میں تفصیلی معلومات دکھائیں۔

**دلائل:**

- `<name>`: ہک کا نام (مثلاً `session-memory`)

**اختیارات:**

- `--json`: JSON کے طور پر آؤٹ پٹ

**مثال:**

```bash
openclaw hooks info session-memory
```

**آؤٹ پٹ:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## ہکس کی اہلیت چیک کریں

```bash
openclaw hooks check
```

ہکس کی اہلیت کی حالت کا خلاصہ دکھائیں (کتنے تیار ہیں بمقابلہ کتنے تیار نہیں)۔

**اختیارات:**

- `--json`: JSON کے طور پر آؤٹ پٹ

**مثالی آؤٹ پٹ:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## ہک فعال کریں

```bash
openclaw hooks enable <name>
```

اپنی کنفیگ (`~/.openclaw/config.json`) میں شامل کر کے کسی مخصوص ہک کو فعال کریں۔

**Note:** Hooks managed by plugins show `plugin:<id>` in `openclaw hooks list` and
can’t be enabled/disabled here. Enable/disable the plugin instead.

**دلائل:**

- `<name>`: ہک کا نام (مثلاً `session-memory`)

**مثال:**

```bash
openclaw hooks enable session-memory
```

**آؤٹ پٹ:**

```
✓ Enabled hook: 💾 session-memory
```

**یہ کیا کرتا ہے:**

- چیک کرتا ہے کہ ہک موجود ہے اور اہل ہے
- Updates `hooks.internal.entries.<name>.enabled = true` in your config
- کنفیگ کو ڈسک پر محفوظ کرتا ہے

**فعال کرنے کے بعد:**

- ہکس دوبارہ لوڈ ہونے کے لیے gateway کو ری اسٹارٹ کریں (macOS پر مینو بار ایپ ری اسٹارٹ کریں، یا ڈویلپمنٹ میں اپنے gateway پراسیس کو ری اسٹارٹ کریں)۔

## ہک غیرفعال کریں

```bash
openclaw hooks disable <name>
```

اپنی کنفیگ کو اپڈیٹ کر کے کسی مخصوص ہک کو غیرفعال کریں۔

**دلائل:**

- `<name>`: ہک کا نام (مثلاً `command-logger`)

**مثال:**

```bash
openclaw hooks disable command-logger
```

**آؤٹ پٹ:**

```
⏸ Disabled hook: 📝 command-logger
```

**غیرفعال کرنے کے بعد:**

- ہکس دوبارہ لوڈ ہونے کے لیے gateway کو ری اسٹارٹ کریں

## ہکس انسٹال کریں

```bash
openclaw hooks install <path-or-spec>
```

لوکل فولڈر/آرکائیو یا npm سے ہک پیک انسٹال کریں۔

**یہ کیا کرتا ہے:**

- ہک پیک کو `~/.openclaw/hooks/<id>` میں کاپی کرتا ہے
- انسٹال شدہ ہکس کو `hooks.internal.entries.*` میں فعال کرتا ہے
- انسٹال کی ریکارڈنگ `hooks.internal.installs` کے تحت کرتا ہے

**اختیارات:**

- `-l, --link`: کاپی کرنے کے بجائے لوکل ڈائریکٹری کو لنک کریں (اسے `hooks.internal.load.extraDirs` میں شامل کرتا ہے)

**معاون آرکائیوز:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**مثالیں:**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## ہکس اپڈیٹ کریں

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

انسٹال شدہ ہک پیکس کو اپڈیٹ کریں (صرف npm انسٹالز)۔

**اختیارات:**

- `--all`: تمام ٹریک شدہ ہک پیکس کو اپڈیٹ کریں
- `--dry-run`: لکھنے کے بغیر دکھائیں کہ کیا تبدیلی آئے گی

## بنڈلڈ ہکس

### session-memory

جب آپ `/new` جاری کرتے ہیں تو سیشن سیاق کو میموری میں محفوظ کرتا ہے۔

**فعال کریں:**

```bash
openclaw hooks enable session-memory
```

**آؤٹ پٹ:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**دیکھیں:** [session-memory دستاویزات](/automation/hooks#session-memory)

### command-logger

تمام کمانڈ ایونٹس کو ایک مرکزی آڈٹ فائل میں لاگ کرتا ہے۔

**فعال کریں:**

```bash
openclaw hooks enable command-logger
```

**آؤٹ پٹ:** `~/.openclaw/logs/commands.log`

**لاگز دیکھیں:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**دیکھیں:** [command-logger دستاویزات](/automation/hooks#command-logger)

### soul-evil

purge ونڈو کے دوران یا اتفاقی امکان کے تحت injected `SOUL.md` مواد کو `SOUL_EVIL.md` سے تبدیل کرتا ہے۔

**فعال کریں:**

```bash
openclaw hooks enable soul-evil
```

**دیکھیں:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

gateway کے شروع ہونے پر (چینلز کے شروع ہونے کے بعد) `BOOT.md` چلاتا ہے۔

**ایونٹس**: `gateway:startup`

**فعال کریں**:

```bash
openclaw hooks enable boot-md
```

**دیکھیں:** [boot-md دستاویزات](/automation/hooks#boot-md)
