---
summary: "Models CLI: فہرست، سیٹ، عرفیات، فالبیکس، اسکین، اسٹیٹس"
read_when:
  - Models CLI (models list/set/scan/aliases/fallbacks) شامل کرتے یا تبدیل کرتے وقت
  - ماڈل فالبیک رویّے یا انتخابی UX میں تبدیلی کرتے وقت
  - ماڈل اسکین پروبز (tools/images) کو اپڈیٹ کرتے وقت
title: "Models CLI"
---

# Models CLI

24. تصدیقی پروفائل روٹیشن، کول ڈاؤنز، اور یہ کہ وہ فالبیکس کے ساتھ کیسے تعامل کرتے ہیں—کے لیے دیکھیں [/concepts/model-failover](/concepts/model-failover)۔
    Quick provider overview + examples: [/concepts/model-providers](/concepts/model-providers).

## ماڈل انتخاب کیسے کام کرتا ہے

OpenClaw اس ترتیب سے ماڈلز منتخب کرتا ہے:

1. **Primary** ماڈل (`agents.defaults.model.primary` یا `agents.defaults.model`)۔
2. **Fallbacks** `agents.defaults.model.fallbacks` میں (ترتیب کے مطابق)۔
3. **Provider auth failover** اگلے ماڈل پر جانے سے پہلے اسی فراہم کنندہ کے اندر ہوتا ہے۔

متعلقہ:

- `agents.defaults.models` وہ allowlist/catalog ہے جن ماڈلز کو OpenClaw استعمال کر سکتا ہے (عرفیات سمیت)۔
- `agents.defaults.imageModel` **صرف اس وقت** استعمال ہوتا ہے جب primary ماڈل تصاویر قبول نہ کر سکے۔
- ہر ایجنٹ کے ڈیفالٹس `agents.defaults.model` کو `agents.list[].model` اور bindings کے ذریعے اووررائیڈ کر سکتے ہیں (دیکھیں [/concepts/multi-agent](/concepts/multi-agent))۔

## فوری ماڈل انتخاب (تجرباتی)

- **GLM**: کوڈنگ/ٹول کالنگ کے لیے قدرے بہتر۔
- **MiniMax**: تحریر اور مجموعی احساس کے لیے بہتر۔

## سیٹ اپ وزارڈ (سفارش کردہ)

اگر آپ کنفیگ کو دستی طور پر ایڈٹ نہیں کرنا چاہتے تو آن بورڈنگ وزارڈ چلائیں:

```bash
openclaw onboard
```

یہ عام فراہم کنندگان کے لیے ماڈل + auth سیٹ اپ کر سکتا ہے، بشمول **OpenAI Code (Codex)
subscription** (OAuth) اور **Anthropic** (API کلید سفارش کردہ؛ `claude
setup-token` بھی سپورٹڈ ہے)۔

## کنفیگ کیز (جائزہ)

- `agents.defaults.model.primary` اور `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` اور `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (allowlist + عرفیات + فراہم کنندہ پیرامیٹرز)
- `models.providers` (حسبِ ضرورت فراہم کنندگان جو `models.json` میں لکھے جاتے ہیں)

Model refs are normalized to lowercase. Provider aliases like `z.ai/*` normalize
to `zai/*`.

فراہم کنندہ کنفیگریشن کی مثالیں (بشمول OpenCode Zen) یہاں موجود ہیں:
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy)۔

## “Model is not allowed” (اور جوابات کیوں رک جاتے ہیں)

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and for
session overrides. When a user selects a model that isn’t in that allowlist,
OpenClaw returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

This happens **before** a normal reply is generated, so the message can feel
like it “didn’t respond.” The fix is to either:

- ماڈل کو `agents.defaults.models` میں شامل کریں، یا
- allowlist صاف کریں (یعنی `agents.defaults.models` ہٹا دیں)، یا
- `/model list` میں سے کوئی ماڈل منتخب کریں۔

مثالی allowlist کنفیگ:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## چیٹ میں ماڈلز تبدیل کرنا (`/model`)

آپ موجودہ سیشن کے لیے ری اسٹارٹ کے بغیر ماڈلز تبدیل کر سکتے ہیں:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

نوٹس:

- `/model` (اور `/model list`) ایک مختصر، نمبر شدہ picker ہے (ماڈل فیملی + دستیاب فراہم کنندگان)۔
- `/model <#>` اسی picker سے انتخاب کرتا ہے۔
- `/model status` تفصیلی منظر ہے (auth امیدواران اور، جب کنفیگر ہو، فراہم کنندہ اینڈپوائنٹ `baseUrl` + `api` موڈ)۔
- Model refs are parsed by splitting on the **first** `/`. Use `provider/model` when typing `/model <ref>`.
- اگر خود ماڈل ID میں `/` شامل ہو (OpenRouter طرز)، تو آپ کو فراہم کنندہ کا prefix شامل کرنا ہوگا (مثال: `/model openrouter/moonshotai/kimi-k2`)۔
- اگر آپ فراہم کنندہ چھوڑ دیں، OpenClaw ان پٹ کو عرف یا **ڈیفالٹ فراہم کنندہ** کے ماڈل کے طور پر سمجھتا ہے (یہ تب ہی کام کرتا ہے جب ماڈل ID میں `/` نہ ہو)۔

مکمل کمانڈ رویّہ/کنفیگ: [Slash commands](/tools/slash-commands)۔

## CLI کمانڈز

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (بغیر سب کمانڈ) دراصل `models status` کا شارٹ کٹ ہے۔

### `models list`

Shows configured models by default. Useful flags:

- `--all`: مکمل کیٹلاگ
- `--local`: صرف لوکل فراہم کنندگان
- `--provider <name>`: فراہم کنندہ کے مطابق فلٹر
- `--plain`: ہر لائن میں ایک ماڈل
- `--json`: مشین کے قابلِ مطالعہ آؤٹ پٹ

### `models status`

Shows the resolved primary model, fallbacks, image model, and an auth overview
of configured providers. It also surfaces OAuth expiry status for profiles found
in the auth store (warns within 24h by default). `--plain` prints only the
resolved primary model.
OAuth status is always shown (and included in `--json` output). 25. اگر کسی کنفیگر شدہ فراہم کنندہ کے پاس اسناد نہ ہوں، تو `models status` ایک **Missing auth** سیکشن پرنٹ کرتا ہے۔
JSON includes `auth.oauth` (warn window + profiles) and `auth.providers`
(effective auth per provider).
Use `--check` for automation (exit `1` when missing/expired, `2` when expiring).

Anthropic کے لیے ترجیحی auth، Claude Code CLI کا setup-token ہے (کہیں بھی چلائیں؛ ضرورت ہو تو گیٹ وے ہوسٹ پر پیسٹ کریں):

```bash
claude setup-token
openclaw models status
```

## اسکیننگ (OpenRouter مفت ماڈلز)

`openclaw models scan` OpenRouter کے **مفت ماڈل کیٹلاگ** کا معائنہ کرتا ہے اور
اختیاری طور پر ٹول اور امیج سپورٹ کے لیے ماڈلز کو پروب کر سکتا ہے۔

اہم flags:

- `--no-probe`: لائیو پروبز اسکیپ کریں (صرف میٹاڈیٹا)
- `--min-params <b>`: کم از کم پیرامیٹر سائز (اربوں میں)
- `--max-age-days <days>`: پرانے ماڈلز اسکیپ کریں
- `--provider <name>`: فراہم کنندہ prefix فلٹر
- `--max-candidates <n>`: فالبیک فہرست کا سائز
- `--set-default`: `agents.defaults.model.primary` کو پہلی سلیکشن پر سیٹ کریں
- `--set-image`: `agents.defaults.imageModel.primary` کو پہلی امیج سلیکشن پر سیٹ کریں

Probing requires an OpenRouter API key (from auth profiles or
`OPENROUTER_API_KEY`). Without a key, use `--no-probe` to list candidates only.

اسکین نتائج کی درجہ بندی یوں کی جاتی ہے:

1. امیج سپورٹ
2. ٹول لیٹنسی
3. کانٹیکسٹ سائز
4. پیرامیٹر کاؤنٹ

ان پٹ

- OpenRouter `/models` فہرست (فلٹر `:free`)
- OpenRouter API کلید درکار ہے (auth پروفائلز یا `OPENROUTER_API_KEY` سے) (دیکھیں [/environment](/help/environment))
- اختیاری فلٹرز: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- پروب کنٹرولز: `--timeout`, `--concurrency`

When run in a TTY, you can select fallbacks interactively. In non‑interactive
mode, pass `--yes` to accept defaults.

## ماڈلز رجسٹری (`models.json`)

Custom providers in `models.providers` are written into `models.json` under the
agent directory (default `~/.openclaw/agents/<agentId>/models.json`). This file
is merged by default unless `models.mode` is set to `replace`.
