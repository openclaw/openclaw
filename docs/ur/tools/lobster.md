---
title: Lobster
summary: "OpenClaw کے لیے ٹائپڈ ورک فلو رَن ٹائم، قابلِ بحالی منظوری گیٹس کے ساتھ۔"
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - آپ کو واضح منظوریوں کے ساتھ تعیّنی کثیر-مرحلہ ورک فلو درکار ہوں
  - آپ کو پہلے مراحل دوبارہ چلائے بغیر ورک فلو بحال کرنے کی ضرورت ہو
---

# Lobster

Lobster ایک ورک فلو شیل ہے جو OpenClaw کو واضح منظوری چیک پوائنٹس کے ساتھ کثیر-مرحلہ اوزار سلسلوں کو ایک واحد، تعیّنی عمل کے طور پر چلانے دیتا ہے۔

## Hook

آپ کا اسسٹنٹ وہ ٹولز خود بنا سکتا ہے جو اسے مینیج کرتے ہیں۔ ایک ورک فلو طلب کریں، اور 30 منٹ بعد آپ کے پاس ایک CLI اور پائپ لائنز ہوں گی جو ایک ہی کال میں چلتی ہیں۔ Lobster وہ گمشدہ حصہ ہے: ڈیٹرمنسٹک پائپ لائنز، واضح منظوریوں، اور دوبارہ شروع ہونے والی اسٹیٹ کے ساتھ۔

## Why

آج، پیچیدہ ورک فلو کے لیے متعدد بار بار ٹول کالز درکار ہوتی ہیں۔ ہر کال ٹوکنز خرچ کرتی ہے، اور LLM کو ہر قدم کی آرکیسٹریشن کرنی پڑتی ہے۔ Lobster اس آرکیسٹریشن کو ایک ٹائپڈ رن ٹائم میں منتقل کر دیتا ہے:

- **کئی کے بجائے ایک کال**: OpenClaw ایک Lobster ٹول کال چلاتا ہے اور ایک ساختہ نتیجہ حاصل کرتا ہے۔
- **منظوریاں اندرونی طور پر**: ضمنی اثرات (ای میل بھیجنا، تبصرہ پوسٹ کرنا) ورک فلو کو اس وقت تک روک دیتے ہیں جب تک واضح منظوری نہ دی جائے۔
- **قابلِ بحالی**: رکے ہوئے ورک فلو ایک ٹوکن واپس کرتے ہیں؛ منظوری دیں اور سب کچھ دوبارہ چلائے بغیر بحال کریں۔

## Why a DSL instead of plain programs?

Lobster جان بوجھ کر چھوٹا رکھا گیا ہے۔ مقصد "ایک نئی زبان" نہیں ہے، بلکہ ایک قابلِ پیش گوئی، AI-فرینڈلی پائپ لائن اسپیک ہے جس میں فرسٹ کلاس منظوریوں اور ریزیوم ٹوکنز شامل ہوں۔

- **منظوری/بحالی اندرونی طور پر**: عام پروگرام انسان سے پوچھ سکتا ہے، مگر آپ کے خود ایجاد کردہ رَن ٹائم کے بغیر پائیدار ٹوکن کے ساتھ _وقفہ اور بحالی_ نہیں کر سکتا۔
- **تعینیت + آڈٹ ایبلٹی**: پائپ لائنز ڈیٹا ہوتی ہیں، اس لیے لاگ کرنا، فرق دیکھنا، دوبارہ چلانا، اور جائزہ لینا آسان ہے۔
- **AI کے لیے محدود سطح**: مختصر گرامر + JSON پائپنگ “تخلیقی” کوڈ راستوں کو کم کرتی ہے اور توثیق کو حقیقت پسندانہ بناتی ہے۔
- **سکیورٹی پالیسی شامل**: ٹائم آؤٹس، آؤٹ پٹ حدود، sandbox چیکس، اور اجازت فہرستیں رَن ٹائم نافذ کرتا ہے، ہر اسکرپٹ نہیں۔
- **اب بھی پروگرام ایبل**: ہر قدم کسی بھی CLI یا اسکرپٹ کو کال کر سکتا ہے۔ اگر آپ JS/TS چاہتے ہیں، تو کوڈ سے `.lobster` فائلیں جنریٹ کریں۔

## How it works

OpenClaw مقامی `lobster` CLI کو **ٹول موڈ** میں لانچ کرتا ہے اور stdout سے ایک JSON لفافہ پارس کرتا ہے۔
اگر پائپ لائن منظوری کے لیے رُک جائے، تو ٹول ایک `resumeToken` واپس کرتا ہے تاکہ آپ بعد میں جاری رکھ سکیں۔

## Pattern: small CLI + JSON pipes + approvals

چھوٹے کمانڈز بنائیں جو JSON بولیں، پھر انہیں ایک واحد Lobster کال میں چین کریں۔ (ذیل میں مثال کے کمانڈ نام ہیں — اپنے نام شامل کریں۔)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

اگر پائپ لائن منظوری مانگے، تو ٹوکن کے ساتھ بحال کریں:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI triggers the workflow; Lobster executes the steps. منظوری کے گیٹس سائیڈ ایفیکٹس کو واضح اور آڈیٹ ایبل رکھتے ہیں۔

مثال: ان پٹ آئٹمز کو ٹول کالز میں میپ کرنا:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

For workflows that need a **structured LLM step**, enable the optional
`llm-task` plugin tool and call it from Lobster. یہ ورک فلو کو ڈیٹرمنسٹک رکھتا ہے جبکہ ماڈل کے ذریعے کلاسیفائی/سمری/ڈرافٹ کرنے کی اجازت دیتا ہے۔

ٹول فعال کریں:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

پائپ لائن میں استعمال کریں:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

تفصیلات اور کنفیگریشن اختیارات کے لیے [LLM Task](/tools/llm-task) دیکھیں۔

## Workflow files (.lobster)

Lobster can run YAML/JSON workflow files with `name`, `args`, `steps`, `env`, `condition`, and `approval` fields. OpenClaw ٹول کالز میں، `pipeline` کو فائل پاتھ پر سیٹ کریں۔

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

نوٹس:

- `stdin: $step.stdout` اور `stdin: $step.json` پچھلے قدم کا آؤٹ پٹ پاس کرتے ہیں۔
- `condition` (یا `when`) مراحل کو `$step.approved` پر گیٹ کر سکتا ہے۔

## Install Lobster

Lobster CLI کو اسی **ہوسٹ** پر انسٹال کریں جو OpenClaw Gateway چلاتا ہے (دیکھیں [Lobster repo](https://github.com/openclaw/lobster))، اور یقینی بنائیں کہ `lobster`، `PATH` میں ہو۔
اگر آپ کسٹم بائنری لوکیشن استعمال کرنا چاہتے ہیں، تو ٹول کال میں ایک **مکمل** `lobsterPath` پاس کریں۔

## Enable the tool

Lobster ایک **اختیاری** پلگ اِن ٹول ہے (بطورِ طے شدہ فعال نہیں)۔

سفارش کردہ (اضافی، محفوظ):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

یا ہر ایجنٹ کے لیے:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

`tools.allow: ["lobster"]` استعمال کرنے سے گریز کریں جب تک کہ آپ پابند اجازت فہرست موڈ میں چلانے کا ارادہ نہ رکھتے ہوں۔

نوٹ: اختیاری پلگ انز کے لیے allowlists آپٹ اِن ہوتی ہیں۔ اگر آپ کی allowlist صرف پلگ ان ٹولز (جیسے `lobster`) کے نام دیتی ہے، تو OpenClaw کور ٹولز کو فعال رکھتا ہے۔ کور ٹولز کو محدود کرنے کے لیے، جن کور ٹولز یا گروپس کی آپ کو ضرورت ہے انہیں allowlist میں بھی شامل کریں۔

## Example: Email triage

Lobster کے بغیر:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Lobster کے ساتھ:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

ایک JSON لفافہ واپس آتا ہے (مختصر):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

صارف منظوری دیتا ہے → بحال کریں:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

ایک ورک فلو۔ ڈیٹرمنسٹک۔ محفوظ۔

## Tool parameters

### `run`

ٹول موڈ میں ایک پائپ لائن چلائیں۔

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

آرگز کے ساتھ ایک ورک فلو فائل چلائیں:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

منظوری کے بعد رکے ہوئے ورک فلو کو جاری رکھیں۔

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: Lobster بائنری کا absolute پاتھ ( `PATH` استعمال کرنے کے لیے خالی چھوڑیں)۔
- `cwd`: پائپ لائن کے لیے ورکنگ ڈائریکٹری (بطورِ طے شدہ موجودہ پروسیس کی ورکنگ ڈائریکٹری)۔
- `timeoutMs`: اگر ذیلی عمل اس مدت سے تجاوز کرے تو اسے ختم کریں (بطورِ طے شدہ: 20000)۔
- `maxStdoutBytes`: اگر stdout اس سائز سے تجاوز کرے تو ذیلی عمل کو ختم کریں (بطورِ طے شدہ: 512000)۔
- `argsJson`: `lobster run --args-json` کو دیا جانے والا JSON اسٹرنگ (صرف ورک فلو فائلیں)۔

## Output envelope

Lobster تین میں سے کسی ایک اسٹیٹس کے ساتھ JSON لفافہ واپس کرتا ہے:

- `ok` → کامیابی سے مکمل
- `needs_approval` → موقوف؛ بحالی کے لیے `requiresApproval.resumeToken` درکار
- `cancelled` → واضح طور پر مسترد یا منسوخ

ٹول لفافہ کو دونوں `content` (خوبصورت JSON) اور `details` (خام آبجیکٹ) میں ظاہر کرتا ہے۔

## Approvals

اگر `requiresApproval` موجود ہو، تو پرامپٹ کا جائزہ لیں اور فیصلہ کریں:

- `approve: true` → بحال کریں اور ضمنی اثرات جاری رکھیں
- `approve: false` → منسوخ کریں اور ورک فلو کو حتمی بنائیں

`approve --preview-from-stdin --limit N` استعمال کریں تاکہ کسٹم jq/heredoc گلو کے بغیر منظوری کی درخواستوں کے ساتھ ایک JSON پریویو منسلک کیا جا سکے۔ ریزیوم ٹوکنز اب مختصر ہیں: Lobster ورک فلو ریزیوم اسٹیٹ کو اپنی اسٹیٹ ڈائریکٹری کے تحت محفوظ کرتا ہے اور ایک چھوٹی ٹوکن کی واپس دیتا ہے۔

## OpenProse

OpenProse، Lobster کے ساتھ اچھی طرح کام کرتا ہے: ملٹی ایجنٹ تیاری کی آرکیسٹریشن کے لیے `/prose` استعمال کریں، پھر ڈیٹرمنسٹک منظوریوں کے لیے Lobster پائپ لائن چلائیں۔ اگر کسی Prose پروگرام کو Lobster درکار ہو، تو سب ایجنٹس کے لیے `tools.subagents.tools` کے ذریعے `lobster` ٹول کی اجازت دیں۔ [OpenProse](/prose) دیکھیں۔

## Safety

- **صرف مقامی ذیلی عمل** — پلگ اِن خود نیٹ ورک کالز نہیں کرتا۔
- **کوئی راز نہیں** — Lobster OAuth منظم نہیں کرتا؛ یہ OpenClaw ٹولز کو کال کرتا ہے جو کرتے ہیں۔
- **Sandbox-aware** — جب ٹول کانٹیکسٹ sandboxed ہو تو غیر فعال۔
- **Hardened** — اگر `lobsterPath` دیا جائے تو absolute ہونا لازم؛ ٹائم آؤٹس اور آؤٹ پٹ حدود نافذ۔

## Troubleshooting

- **`lobster subprocess timed out`** → `timeoutMs` بڑھائیں، یا طویل پائپ لائن کو تقسیم کریں۔
- **`lobster output exceeded maxStdoutBytes`** → `maxStdoutBytes` بڑھائیں یا آؤٹ پٹ سائز کم کریں۔
- **`lobster returned invalid JSON`** → یقینی بنائیں کہ پائپ لائن ٹول موڈ میں چلتی ہے اور صرف JSON پرنٹ کرتی ہے۔
- **`lobster failed (code …)`** → stderr کا معائنہ کرنے کے لیے وہی پائپ لائن ٹرمینل میں چلائیں۔

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

ایک عوامی مثال: ایک “سیکنڈ برین” CLI + Lobster پائپ لائنز جو تین Markdown والٹس (ذاتی، پارٹنر، مشترکہ) کو مینیج کرتی ہیں۔ The CLI emits JSON for stats, inbox listings, and stale scans; Lobster chains those commands into workflows like `weekly-review`, `inbox-triage`, `memory-consolidation`, and `shared-task-sync`, each with approval gates. AI دستیاب ہونے پر فیصلہ سازی (کیٹیگرائزیشن) سنبھالتا ہے اور نہ ہونے پر ڈیٹرمنسٹک قواعد پر واپس آتا ہے۔

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
