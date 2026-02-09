---
summary: "سیاق: ماڈل کیا دیکھتا ہے، یہ کیسے بنایا جاتا ہے، اور اس کا معائنہ کیسے کیا جائے"
read_when:
  - آپ یہ سمجھنا چاہتے ہیں کہ OpenClaw میں “context” سے کیا مراد ہے
  - آپ یہ ڈیبگ کر رہے ہیں کہ ماڈل کسی چیز کو “کیوں جانتا” ہے (یا کیوں بھول گیا)
  - آپ context اوورہیڈ کم کرنا چاہتے ہیں (/context، /status، /compact)
title: "Context"
---

# Context

18. “کانٹیکسٹ” وہ **سب کچھ ہے جو OpenClaw کسی رن کے لیے ماڈل کو بھیجتا ہے**۔ یہ ماڈل کی **context window** (ٹوکن حد) کے ذریعے محدود ہوتا ہے۔

مبتدی کے لیے ذہنی ماڈل:

- **System prompt** (OpenClaw کی جانب سے تیار کردہ): قواعد، اوزار، Skills کی فہرست، وقت/رن ٹائم، اور injected ورک اسپیس فائلیں۔
- **Conversation history**: اس سیشن کے لیے آپ کے پیغامات + اسسٹنٹ کے پیغامات۔
- **Tool calls/results + attachments**: کمانڈ آؤٹ پٹ، فائل ریڈز، تصاویر/آڈیو، وغیرہ۔

Context، “memory” جیسی چیز **نہیں** ہے: میموری کو ڈسک پر محفوظ کر کے بعد میں دوبارہ لوڈ کیا جا سکتا ہے؛ جبکہ context وہ ہے جو اس وقت ماڈل کی موجودہ ونڈو کے اندر ہے۔

## فوری آغاز (context کا معائنہ)

- `/status` → فوری “میری ونڈو کتنی بھری ہے؟” ویو + سیشن سیٹنگز۔
- `/context list` → کیا injected ہے + اندازاً سائزز (ہر فائل کے مطابق + مجموعی)۔
- `/context detail` → گہری تقسیم: فی فائل، فی ٹول اسکیما سائزز، فی اسکل انٹری سائزز، اور system prompt سائز۔
- `/usage tokens` → معمول کی جوابات میں فی-ریپلائی استعمال کا فوٹر شامل کریں۔
- `/compact` → پرانی ہسٹری کو مختصر انٹری میں سمیٹیں تاکہ ونڈو کی جگہ خالی ہو۔

یہ بھی دیکھیں: [Slash commands](/tools/slash-commands)، [Token use & costs](/reference/token-use)، [Compaction](/concepts/compaction)۔

## مثال آؤٹ پٹ

قدریں ماڈل، فراہم کنندہ، ٹول پالیسی، اور آپ کی ورک اسپیس کے مواد کے مطابق مختلف ہوتی ہیں۔

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## context window میں کیا شمار ہوتا ہے

ماڈل کو موصول ہونے والی ہر چیز شمار ہوتی ہے، بشمول:

- System prompt (تمام حصے)۔
- Conversation history۔
- Tool calls + tool results۔
- Attachments/transcripts (تصاویر/آڈیو/فائلیں)۔
- Compaction summaries اور pruning artifacts۔
- فراہم کنندہ کے “wrappers” یا مخفی headers (نظر نہیں آتے، پھر بھی شمار ہوتے ہیں)۔

## OpenClaw system prompt کیسے بناتا ہے

سسٹم پرامپٹ **OpenClaw کی ملکیت** ہے اور ہر رن میں دوبارہ بنایا جاتا ہے۔ اس میں شامل ہیں:

- ٹولز کی فہرست + مختصر توضیحات۔
- Skills کی فہرست (صرف metadata؛ نیچے دیکھیں)۔
- ورک اسپیس کا مقام۔
- وقت (UTC + اگر کنفیگر ہو تو صارف کے وقت میں تبدیلی)۔
- رن ٹائم metadata (ہوسٹ/OS/ماڈل/سوچ)۔
- **Project Context** کے تحت injected ورک اسپیس bootstrap فائلیں۔

مکمل تقسیم: [System Prompt](/concepts/system-prompt)۔

## Injected ورک اسپیس فائلیں (Project Context)

بطورِ طے شدہ، OpenClaw ورک اسپیس کی ایک مقررہ فائلوں کا سیٹ inject کرتا ہے (اگر موجود ہوں):

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (صرف پہلی بار)

بڑی فائلیں ہر فائل کی بنیاد پر `agents.defaults.bootstrapMaxChars` (ڈیفالٹ `20000` حروف) استعمال کرتے ہوئے truncate کی جاتی ہیں۔ `/context` **raw بمقابلہ injected** سائزز دکھاتا ہے اور یہ بھی کہ truncation ہوئی یا نہیں۔

## Skills: کیا injected ہوتا ہے بمقابلہ کیا ضرورت پر لوڈ ہوتا ہے

سسٹم پرامپٹ میں ایک مختصر **skills list** شامل ہوتی ہے (نام + وضاحت + مقام)۔ اس فہرست کا حقیقی اوورہیڈ ہوتا ہے۔

Skill ہدایات ڈیفالٹ طور پر شامل نہیں ہوتیں۔ ماڈل سے توقع کی جاتی ہے کہ وہ skill کی `SKILL.md` **صرف ضرورت پڑنے پر** `read` کرے۔

## Tools: دو طرح کے اخراجات ہوتے ہیں

Tools دو طریقوں سے context کو متاثر کرتے ہیں:

1. System prompt میں **Tool list متن** (جو آپ “Tooling” کے طور پر دیکھتے ہیں)۔
2. **Tool schemas** (JSON)۔ یہ ماڈل کو بھیجے جاتے ہیں تاکہ وہ ٹولز کال کر سکے۔ یہ context میں شمار ہوتے ہیں اگرچہ آپ انہیں سادہ متن کے طور پر نہیں دیکھتے۔

`/context detail` سب سے بڑے ٹول اسکیماز کی تقسیم دکھاتا ہے تاکہ آپ دیکھ سکیں کہ کیا غالب ہے۔

## Commands، directives، اور “inline shortcuts”

Slash کمانڈز Gateway کے ذریعے ہینڈل کی جاتی ہیں۔ کچھ مختلف رویے ہیں:

- **Standalone commands**: ایسا پیغام جو صرف `/...` ہو، کمانڈ کے طور پر چلتا ہے۔
- **Directives**: `/think`، `/verbose`، `/reasoning`، `/elevated`، `/model`، `/queue` ماڈل کے پیغام دیکھنے سے پہلے ہٹا دیے جاتے ہیں۔
  - صرف-directive پیغامات سیشن سیٹنگز کو برقرار رکھتے ہیں۔
  - عام پیغام میں inline directives فی-پیغام اشاروں کے طور پر کام کرتے ہیں۔
- **Inline shortcuts** (صرف اجازت فہرست میں شامل ارسال کنندگان): عام پیغام کے اندر کچھ `/...` ٹوکنز فوراً چل سکتے ہیں (مثال: “hey /status”)، اور باقی متن دیکھنے سے پہلے ہٹا دیے جاتے ہیں۔

تفصیلات: [Slash commands](/tools/slash-commands)۔

## Sessions، compaction، اور pruning (کیا برقرار رہتا ہے)

پیغامات کے درمیان کیا برقرار رہتا ہے، اس کا انحصار طریقۂ کار پر ہے:

- **Normal history** سیشن ٹرانسکرپٹ میں پالیسی کے مطابق compact/prune ہونے تک برقرار رہتی ہے۔
- **Compaction** ایک خلاصہ ٹرانسکرپٹ میں محفوظ کرتی ہے اور حالیہ پیغامات کو برقرار رکھتی ہے۔
- **Pruning** کسی رَن کے لیے _in-memory_ prompt سے پرانے ٹول نتائج ہٹا دیتی ہے، مگر ٹرانسکرپٹ کو دوبارہ نہیں لکھتی۔

دستاویزات: [Session](/concepts/session)، [Compaction](/concepts/compaction)، [Session pruning](/concepts/session-pruning)۔

## `/context` دراصل کیا رپورٹ کرتا ہے

`/context` جب دستیاب ہو تو تازہ ترین **run-built** system prompt رپورٹ کو ترجیح دیتا ہے:

- `System prompt (run)` = آخری embedded (tool-capable) رَن سے حاصل کی گئی اور سیشن اسٹور میں محفوظ کی گئی۔
- `System prompt (estimate)` = جب کوئی رَن رپورٹ موجود نہ ہو (یا CLI بیک اینڈ کے ذریعے چلانے پر جو رپورٹ پیدا نہیں کرتا) تو فوری طور پر حساب کی جاتی ہے۔

دونوں صورتوں میں، یہ سائزز اور نمایاں شراکت داروں کی رپورٹ دیتا ہے؛ یہ **مکمل** system prompt یا tool schemas کو ڈمپ نہیں کرتا۔
