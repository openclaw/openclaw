---
summary: "CLI بیک اینڈز: مقامی AI CLI کے ذریعے صرف-متن فال بیک"
read_when:
  - آپ کو اس وقت ایک قابلِ اعتماد فال بیک درکار ہے جب API فراہم کنندگان ناکام ہوں
  - آپ Claude Code CLI یا دیگر مقامی AI CLI چلا رہے ہیں اور انہیں دوبارہ استعمال کرنا چاہتے ہیں
  - آپ کو ایک صرف-متن، بغیر اوزار کے راستے کی ضرورت ہے جو پھر بھی سیشنز اور تصاویر کو سپورٹ کرے
title: "CLI بیک اینڈز"
---

# CLI بیک اینڈز (فال بیک رن ٹائم)

OpenClaw **local AI CLIs** کو **text‑only fallback** کے طور پر چلا سکتا ہے جب API providers ڈاؤن ہوں، rate‑limited ہوں، یا عارضی طور پر غلط رویہ دکھا رہے ہوں۔ یہ جان بوجھ کر محتاط رکھا گیا ہے:

- **Tools غیر فعال ہیں** (کوئی tool calls نہیں)۔
- **متن اندر → متن باہر** (قابلِ اعتماد)۔
- **سیشنز سپورٹڈ ہیں** (تاکہ فالو اپ ٹرنز مربوط رہیں)۔
- **تصاویر پاس تھرو کی جا سکتی ہیں** اگر CLI امیج پاتھ قبول کرتا ہو۔

یہ **safety net** کے طور پر ڈیزائن کیا گیا ہے، نہ کہ بنیادی راستے کے طور پر۔ Use it when you
want “always works” text responses without relying on external APIs.

## مبتدیوں کے لیے فوری آغاز

آپ Claude Code CLI کو **بغیر کسی کنفیگ** کے استعمال کر سکتے ہیں (OpenClaw ایک بلٹ اِن ڈیفالٹ کے ساتھ آتا ہے):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI بھی آؤٹ آف دی باکس کام کرتا ہے:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

اگر آپ کا گیٹ وے launchd/systemd کے تحت چلتا ہے اور PATH محدود ہے، تو صرف
کمانڈ کا پاتھ شامل کریں:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

بس اتنا ہی۔ کوئی keys نہیں، CLI خود کے علاوہ کسی اضافی auth کنفگ کی ضرورت نہیں۔

## اسے فال بیک کے طور پر استعمال کرنا

فال بیک لسٹ میں ایک CLI بیک اینڈ شامل کریں تاکہ یہ صرف اس وقت چلے جب بنیادی ماڈلز ناکام ہوں:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

نوٹس:

- اگر آپ `agents.defaults.models` (allowlist) استعمال کرتے ہیں، تو آپ کو `claude-cli/...` شامل کرنا ہوگا۔
- اگر بنیادی فراہم کنندہ ناکام ہو (تصدیق، ریٹ لمٹس، ٹائم آؤٹس)، تو OpenClaw
  اگلا CLI بیک اینڈ آزمائے گا۔

## کنفیگریشن کا جائزہ

تمام CLI بیک اینڈز یہاں موجود ہوتے ہیں:

```
agents.defaults.cliBackends
```

ہر entry ایک **provider id** (مثلاً `claude-cli`, `my-cli`) سے keyed ہوتی ہے۔
The provider id becomes the left side of your model ref:

```
<provider>/<model>
```

### مثال کنفیگریشن

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## یہ کیسے کام کرتا ہے

1. **ایک بیک اینڈ منتخب کرتا ہے** provider prefix (`claude-cli/...`) کی بنیاد پر۔
2. **سسٹم پرامپٹ تیار کرتا ہے** وہی OpenClaw پرامپٹ + ورک اسپیس سیاق استعمال کرتے ہوئے۔
3. **CLI کو چلاتا ہے** ایک سیشن آئی ڈی کے ساتھ (اگر سپورٹڈ ہو) تاکہ ہسٹری یکساں رہے۔
4. **آؤٹ پٹ پارس کرتا ہے** (JSON یا سادہ متن) اور حتمی متن واپس کرتا ہے۔
5. **ہر بیک اینڈ کے لیے سیشن آئی ڈیز محفوظ کرتا ہے** تاکہ فالو اپس وہی CLI سیشن دوبارہ استعمال کریں۔

## سیشنز

- اگر CLI سیشنز سپورٹ کرتا ہے، تو `sessionArg` سیٹ کریں (مثلاً `--session-id`) یا
  `sessionArgs` (پلیس ہولڈر `{sessionId}`) جب آئی ڈی کو متعدد فلیگز میں داخل کرنا ہو۔
- اگر CLI مختلف فلیگز کے ساتھ **resume سب کمانڈ** استعمال کرتا ہے، تو
  `resumeArgs` سیٹ کریں (resume کے وقت `args` کی جگہ لیتا ہے) اور اختیاری طور پر `resumeOutput`
  (نان-JSON resume کے لیے)۔
- `sessionMode`:
  - `always`: ہمیشہ ایک سیشن آئی ڈی بھیجیں (اگر محفوظ نہ ہو تو نیا UUID)۔
  - `existing`: صرف اس صورت میں سیشن آئی ڈی بھیجیں اگر پہلے محفوظ ہو۔
  - `none`: کبھی بھی سیشن آئی ڈی نہ بھیجیں۔

## تصاویر (پاس تھرو)

اگر آپ کا CLI امیج پاتھ قبول کرتا ہے، تو `imageArg` سیٹ کریں:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw base64 تصاویر کو temp فائلوں میں لکھے گا۔ اگر `imageArg` سیٹ ہو تو وہ paths CLI args کے طور پر پاس کی جاتی ہیں۔ اگر `imageArg` موجود نہ ہو تو OpenClaw فائل paths کو prompt کے ساتھ append کر دیتا ہے (path injection)، جو اُن CLIs کے لیے کافی ہے جو سادہ paths سے مقامی فائلیں خود بخود لوڈ کر لیتے ہیں (Claude Code CLI کا رویہ)۔

## اِن پٹس / آؤٹ پٹس

- `output: "json"` (ڈیفالٹ) JSON پارس کرنے اور متن + سیشن آئی ڈی نکالنے کی کوشش کرتا ہے۔
- `output: "jsonl"` JSONL اسٹریمز پارس کرتا ہے (Codex CLI `--json`) اور آخری
  ایجنٹ پیغام کے ساتھ `thread_id` (جب موجود ہو) نکالتا ہے۔
- `output: "text"` stdout کو حتمی جواب سمجھتا ہے۔

اِن پٹ موڈز:

- `input: "arg"` (ڈیفالٹ) پرامپٹ کو آخری CLI آرگ کے طور پر پاس کرتا ہے۔
- `input: "stdin"` پرامپٹ stdin کے ذریعے بھیجتا ہے۔
- اگر پرامپٹ بہت طویل ہو اور `maxPromptArgChars` سیٹ ہو، تو stdin استعمال کیا جاتا ہے۔

## ڈیفالٹس (بلٹ اِن)

OpenClaw `claude-cli` کے لیے ایک ڈیفالٹ کے ساتھ آتا ہے:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw `codex-cli` کے لیے بھی ایک ڈیفالٹ فراہم کرتا ہے:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

صرف ضرورت پڑنے پر اووررائیڈ کریں (عام مثال: مکمل `command` پاتھ)۔

## حدود

- **کوئی OpenClaw tools نہیں** (CLI backend کو کبھی tool calls موصول نہیں ہوتیں)۔ Some CLIs
  may still run their own agent tooling.
- **اسٹریمنگ نہیں** (CLI آؤٹ پٹ اکٹھا کر کے واپس کیا جاتا ہے)۔
- **اسٹرکچرڈ آؤٹ پٹس** CLI کے JSON فارمیٹ پر منحصر ہیں۔
- **Codex CLI sessions** resume via text output (no JSONL), which is less
  structured than the initial `--json` run. OpenClaw sessions پھر بھی معمول کے مطابق کام کرتی ہیں۔

## خرابیوں کا ازالہ

- **CLI نہیں مل رہا**: `command` کو مکمل پاتھ پر سیٹ کریں۔
- **غلط ماڈل نام**: `modelAliases` استعمال کریں تاکہ `provider/model` → CLI ماڈل میپ ہو۔
- **سیشن کا تسلسل نہیں**: یقینی بنائیں کہ `sessionArg` سیٹ ہے اور `sessionMode`
  `none` نہیں ہے (Codex CLI فی الحال JSON آؤٹ پٹ کے ساتھ resume نہیں کر سکتا)۔
- **تصاویر نظرانداز ہو رہی ہیں**: `imageArg` سیٹ کریں (اور تصدیق کریں کہ CLI فائل پاتھس سپورٹ کرتا ہے)۔
