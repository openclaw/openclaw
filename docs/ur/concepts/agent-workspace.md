---
summary: "ایجنٹ ورک اسپیس: مقام، ترتیب، اور بیک اپ حکمتِ عملی"
read_when:
  - آپ کو ایجنٹ ورک اسپیس یا اس کی فائل ترتیب کی وضاحت درکار ہو
  - آپ ایجنٹ ورک اسپیس کا بیک اپ لینا یا اسے منتقل کرنا چاہتے ہوں
title: "ایجنٹ ورک اسپیس"
---

# ایجنٹ ورک اسپیس

16. ورک اسپیس ایجنٹ کا گھر ہوتا ہے۔ It is the only working directory used for
    file tools and for workspace context. Keep it private and treat it as memory.

یہ `~/.openclaw/` سے الگ ہے، جو کنفیگ، اسناد، اور سیشنز کو محفوظ کرتا ہے۔

**Important:** the workspace is the **default cwd**, not a hard sandbox. Tools
resolve relative paths against the workspace, but absolute paths can still reach
elsewhere on the host unless sandboxing is enabled. If you need isolation, use
[`agents.defaults.sandbox`](/gateway/sandboxing) (and/or per‑agent sandbox config).
When sandboxing is enabled and `workspaceAccess` is not `"rw"`, tools operate
inside a sandbox workspace under `~/.openclaw/sandboxes`, not your host workspace.

## بطورِ طے شدہ مقام

- بطورِ طے شدہ: `~/.openclaw/workspace`
- اگر `OPENCLAW_PROFILE` سیٹ ہو اور `"default"` نہ ہو، تو بطورِ طے شدہ مقام
  `~/.openclaw/workspace-<profile>` بن جاتا ہے۔
- `~/.openclaw/openclaw.json` میں اوور رائیڈ کریں:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`، `openclaw configure`، یا `openclaw setup` ورک اسپیس بنائیں گے اور اگر بوٹ اسٹرپ فائلیں موجود نہ ہوں تو انہیں سیڈ کریں گے۔

اگر آپ پہلے ہی ورک اسپیس فائلوں کو خود منظم کرتے ہیں، تو آپ بوٹ اسٹرپ فائل کی تخلیق غیر فعال کر سکتے ہیں:

```json5
{ agent: { skipBootstrap: true } }
```

## اضافی ورک اسپیس فولڈرز

Older installs may have created `~/openclaw`. Keeping multiple workspace
directories around can cause confusing auth or state drift, because only one
workspace is active at a time.

**Recommendation:** keep a single active workspace. If you no longer use the
extra folders, archive or move them to Trash (for example `trash ~/openclaw`).
If you intentionally keep multiple workspaces, make sure
`agents.defaults.workspace` points to the active one.

`openclaw doctor` اضافی ورک اسپیس ڈائریکٹریز کا پتہ چلنے پر خبردار کرتا ہے۔

## ورک اسپیس فائل میپ (ہر فائل کا مطلب)

یہ وہ معیاری فائلیں ہیں جن کی OpenClaw ورک اسپیس کے اندر توقع کرتا ہے:

- `AGENTS.md`
  - ایجنٹ کے لیے عملی ہدایات اور میموری کے استعمال کا طریقہ۔
  - ہر سیشن کے آغاز پر لوڈ ہوتی ہے۔
  - قواعد، ترجیحات، اور “کیسے برتاؤ کرنا ہے” جیسی تفصیلات کے لیے موزوں جگہ۔

- `SOUL.md`
  - شخصیت، لہجہ، اور حدود۔
  - ہر سیشن میں لوڈ ہوتی ہے۔

- `USER.md`
  - صارف کون ہے اور اسے کیسے مخاطب کرنا ہے۔
  - ہر سیشن میں لوڈ ہوتی ہے۔

- `IDENTITY.md`
  - ایجنٹ کا نام، انداز، اور ایموجی۔
  - بوٹ اسٹرپ رسم کے دوران تخلیق/اپ ڈیٹ ہوتی ہے۔

- `TOOLS.md`
  - آپ کے مقامی اوزار اور روایات کے بارے میں نوٹس۔
  - اوزاروں کی دستیابی کو کنٹرول نہیں کرتی؛ صرف رہنمائی ہے۔

- `HEARTBEAT.md`
  - ہارٹ بیٹ رنز کے لیے اختیاری مختصر چیک لسٹ۔
  - ٹوکن کے ضیاع سے بچنے کے لیے مختصر رکھیں۔

- `BOOT.md`
  - اختیاری اسٹارٹ اپ چیک لسٹ جو gateway ری اسٹارٹ پر چلتی ہے جب اندرونی ہُکس فعال ہوں۔
  - مختصر رکھیں؛ بیرونی ارسال کے لیے میسج ٹول استعمال کریں۔

- `BOOTSTRAP.md`
  - پہلی بار چلنے کی ایک وقتی رسم۔
  - صرف بالکل نئی ورک اسپیس کے لیے بنائی جاتی ہے۔
  - رسم مکمل ہونے کے بعد اسے حذف کر دیں۔

- `memory/YYYY-MM-DD.md`
  - روزانہ میموری لاگ (روزانہ ایک فائل)۔
  - سیشن شروع ہونے پر آج + کل کی فائل پڑھنے کی سفارش۔

- `MEMORY.md` (اختیاری)
  - مرتب شدہ طویل المدتی میموری۔
  - صرف مرکزی، نجی سیشن میں لوڈ کریں (مشترکہ/گروپ سیاق میں نہیں)۔

ورک فلو اور خودکار میموری فلش کے لیے [Memory](/concepts/memory) دیکھیں۔

- `skills/` (اختیاری)
  - ورک اسپیس سے مخصوص Skills۔
  - نام ٹکرانے پر منظم/بنڈل شدہ Skills کو اوور رائیڈ کرتی ہیں۔

- `canvas/` (اختیاری)
  - نوڈ ڈسپلے کے لیے Canvas UI فائلیں (مثال کے طور پر `canvas/index.html`)۔

If any bootstrap file is missing, OpenClaw injects a "missing file" marker into
the session and continues. Large bootstrap files are truncated when injected;
adjust the limit with `agents.defaults.bootstrapMaxChars` (default: 20000).
`openclaw setup` can recreate missing defaults without overwriting existing
files.

## ورک اسپیس میں کیا شامل نہیں

یہ چیزیں `~/.openclaw/` کے تحت ہوتی ہیں اور ورک اسپیس ریپو میں شامل **نہیں** ہونی چاہئیں:

- `~/.openclaw/openclaw.json` (کنفیگ)
- `~/.openclaw/credentials/` (OAuth ٹوکنز، API کلیدیں)
- `~/.openclaw/agents/<agentId>/sessions/` (سیشن ٹرانسکرپٹس + میٹاڈیٹا)
- `~/.openclaw/skills/` (منظم Skills)

اگر آپ کو سیشنز یا کنفیگ منتقل کرنے کی ضرورت ہو تو انہیں الگ سے کاپی کریں اور ورژن کنٹرول سے باہر رکھیں۔

## Git بیک اپ (سفارش کردہ، نجی)

Treat the workspace as private memory. Put it in a **private** git repo so it is
backed up and recoverable.

یہ مراحل اسی مشین پر چلائیں جہاں Gateway چلتا ہے (وہیں ورک اسپیس موجود ہوتی ہے)۔

### 1. ریپو کو ابتدا دیں

17. اگر git انسٹال ہو، تو بالکل نئی ورک اسپیسز خودکار طور پر ابتدائی حالت میں لائی جاتی ہیں۔ If this
    workspace is not already a repo, run:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. نجی ریموٹ شامل کریں (مبتدی دوست آپشنز)

آپشن A: GitHub ویب UI

1. GitHub پر ایک نیا **نجی** ریپوزٹری بنائیں۔
2. README کے ساتھ ابتدا نہ کریں (مرج تنازعات سے بچاؤ)۔
3. HTTPS ریموٹ URL کاپی کریں۔
4. ریموٹ شامل کریں اور پُش کریں:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

آپشن B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

آپشن C: GitLab ویب UI

1. GitLab پر ایک نیا **نجی** ریپوزٹری بنائیں۔
2. README کے ساتھ ابتدا نہ کریں (مرج تنازعات سے بچاؤ)۔
3. HTTPS ریموٹ URL کاپی کریں۔
4. ریموٹ شامل کریں اور پُش کریں:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. جاری اپ ڈیٹس

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## راز کمٹ نہ کریں

نجی ریپو میں بھی، ورک اسپیس میں راز محفوظ کرنے سے گریز کریں:

- API کلیدیں، OAuth ٹوکنز، پاس ورڈز، یا نجی اسناد۔
- `~/.openclaw/` کے تحت کوئی بھی چیز۔
- چیٹس کے خام ڈمپس یا حساس اٹیچمنٹس۔

اگر حساس حوالہ جات محفوظ کرنا ناگزیر ہوں تو پلیس ہولڈرز استعمال کریں اور اصل راز کہیں اور رکھیں (پاس ورڈ مینیجر، ماحولیاتی متغیرات، یا `~/.openclaw/`)۔

مجوزہ `.gitignore` اسٹارٹر:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## ورک اسپیس کو نئی مشین پر منتقل کرنا

1. ریپو کو مطلوبہ راستے پر کلون کریں (بطورِ طے شدہ `~/.openclaw/workspace`)۔
2. `~/.openclaw/openclaw.json` میں `agents.defaults.workspace` کو اس راستے پر سیٹ کریں۔
3. کسی بھی غائب فائل کو سیڈ کرنے کے لیے `openclaw setup --workspace <path>` چلائیں۔
4. اگر سیشنز درکار ہوں تو `~/.openclaw/agents/<agentId>/sessions/` کو پرانی مشین سے الگ سے کاپی کریں۔

## اعلیٰ درجے کے نوٹس

- Multi-agent routing can use different workspaces per agent. See
  [Channel routing](/channels/channel-routing) for routing configuration.
- اگر `agents.defaults.sandbox` فعال ہو تو غیر مرکزی سیشنز `agents.defaults.sandbox.workspaceRoot` کے تحت فی سیشن sandbox ورک اسپیسز استعمال کر سکتے ہیں۔
