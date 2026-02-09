---
summary: "بیک گراؤنڈ exec کی عمل درآمد اور پروسیس مینجمنٹ"
read_when:
  - بیک گراؤنڈ exec کے رویّے کو شامل یا تبدیل کرتے وقت
  - طویل المدت exec ٹاسکس کی ڈیبگنگ کے دوران
title: "بیک گراؤنڈ Exec اور پروسیس ٹول"
---

# بیک گراؤنڈ Exec + پروسیس ٹول

OpenClaw شیل کمانڈز کو `exec` ٹول کے ذریعے چلاتا ہے اور طویل مدتی ٹاسکس کو میموری میں رکھتا ہے۔ 48. `process` ٹول ان بیک گراؤنڈ سیشنز کو منظم کرتا ہے۔

## exec ٹول

اہم پیرامیٹرز:

- `command` (لازم)
- `yieldMs` (بطورِ طے شدہ 10000): اس تاخیر کے بعد خودکار طور پر بیک گراؤنڈ
- `background` (bool): فوراً بیک گراؤنڈ کریں
- `timeout` (سیکنڈز، بطورِ طے شدہ 1800): اس ٹائم آؤٹ کے بعد پروسیس ختم کریں
- `elevated` (bool): اگر ایلیویٹڈ موڈ فعال/اجازت یافتہ ہو تو ہوسٹ پر چلائیں
- 49. حقیقی TTY کی ضرورت ہے؟ 50. `pty: true` سیٹ کریں۔
- `workdir`, `env`

رویّہ:

- فورگراؤنڈ رنز آؤٹ پٹ براہِ راست واپس کرتے ہیں۔
- جب بیک گراؤنڈ کیا جائے (واضح طور پر یا ٹائم آؤٹ پر)، ٹول `status: "running"` + `sessionId` اور ایک مختصر ٹیل واپس کرتا ہے۔
- آؤٹ پٹ میموری میں برقرار رہتا ہے جب تک سیشن کو پول یا کلیئر نہ کیا جائے۔
- اگر `process` ٹول غیر مجاز ہو، تو `exec` ہم وقتی طور پر چلتا ہے اور `yieldMs`/`background` کو نظرانداز کرتا ہے۔

## چائلڈ پروسیس برجنگ

When spawning long-running child processes outside the exec/process tools (for example, CLI respawns or gateway helpers), attach the child-process bridge helper so termination signals are forwarded and listeners are detached on exit/error. اس سے systemd پر orphaned processes سے بچاؤ ہوتا ہے اور shutdown رویہ تمام پلیٹ فارمز پر یکساں رہتا ہے۔

ماحولیاتی اووررائیڈز:

- `PI_BASH_YIELD_MS`: بطورِ طے شدہ ییلڈ (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: میموری میں آؤٹ پٹ کی حد (حروف)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: فی اسٹریم زیرِ التواء stdout/stderr کی حد (حروف)
- `PI_BASH_JOB_TTL_MS`: مکمل شدہ سیشنز کے لیے TTL (ms، 1m–3h تک محدود)

کنفیگریشن (ترجیحی):

- `tools.exec.backgroundMs` (بطورِ طے شدہ 10000)
- `tools.exec.timeoutSec` (بطورِ طے شدہ 1800)
- `tools.exec.cleanupMs` (بطورِ طے شدہ 1800000)
- `tools.exec.notifyOnExit` (بطورِ طے شدہ true): جب بیک گراؤنڈ کیا گیا exec ختم ہو تو سسٹم ایونٹ قطار میں ڈالیں + ہارٹ بیٹ کی درخواست کریں۔

## process ٹول

ایکشنز:

- `list`: چلتے ہوئے + مکمل شدہ سیشنز
- `poll`: کسی سیشن کے لیے نیا آؤٹ پٹ ڈرین کریں (ایگزٹ اسٹیٹس بھی رپورٹ کرتا ہے)
- `log`: مجموعی آؤٹ پٹ پڑھیں ( `offset` + `limit` کی سپورٹ کے ساتھ)
- `write`: stdin بھیجیں (`data`، اختیاری `eof`)
- `kill`: بیک گراؤنڈ سیشن ختم کریں
- `clear`: مکمل شدہ سیشن کو میموری سے ہٹا دیں
- `remove`: اگر چل رہا ہو تو kill کریں، بصورتِ دیگر اگر مکمل ہو چکا ہو تو کلیئر کریں

نوٹس:

- صرف بیک گراؤنڈ کیے گئے سیشنز فہرست میں آتے ہیں/میموری میں برقرار رہتے ہیں۔
- پروسیس ری اسٹارٹ پر سیشنز ضائع ہو جاتے ہیں (ڈسک پر مستقل ذخیرہ نہیں)۔
- سیشن لاگز چیٹ ہسٹری میں صرف اسی صورت محفوظ ہوتے ہیں جب آپ `process poll/log` چلائیں اور ٹول کا نتیجہ ریکارڈ ہو۔
- `process` ہر ایجنٹ کے لیے مخصوص ہے؛ یہ صرف اسی ایجنٹ کے شروع کیے گئے سیشنز دیکھتا ہے۔
- `process list` میں فوری جائزے کے لیے ایک اخذ کردہ `name` (کمانڈ ورب + ہدف) شامل ہوتا ہے۔
- `process log` لائن پر مبنی `offset`/`limit` استعمال کرتا ہے (آخری N لائنیں لینے کے لیے `offset` کو چھوڑ دیں)۔

## مثالیں

ایک طویل ٹاسک چلائیں اور بعد میں پول کریں:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

فوراً بیک گراؤنڈ میں شروع کریں:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

stdin بھیجیں:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
