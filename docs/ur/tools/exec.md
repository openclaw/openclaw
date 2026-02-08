---
summary: "Exec ٹول کا استعمال، stdin موڈز، اور TTY سپورٹ"
read_when:
  - Exec ٹول کا استعمال یا ترمیم کرتے وقت
  - stdin یا TTY کے رویّے کی ڈیبگنگ کرتے وقت
title: "Exec ٹول"
x-i18n:
  source_path: tools/exec.md
  source_hash: 3b32238dd8dce93d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:59Z
---

# Exec ٹول

ورک اسپیس میں شیل کمانڈز چلائیں۔ `process` کے ذریعے foreground اور background دونوں میں اجرا کی حمایت کرتا ہے۔
اگر `process` کی اجازت نہ ہو، تو `exec` ہم وقتی طور پر چلتا ہے اور `yieldMs`/`background` کو نظر انداز کرتا ہے۔
بیک گراؤنڈ سیشنز ہر ایجنٹ کے دائرے میں ہوتے ہیں؛ `process` صرف اسی ایجنٹ کے سیشنز دیکھتا ہے۔

## Parameters

- `command` (لازم)
- `workdir` (بطورِ طے شدہ cwd)
- `env` (key/value اوور رائیڈز)
- `yieldMs` (بطورِ طے شدہ 10000): تاخیر کے بعد خودکار بیک گراؤنڈ
- `background` (bool): فوراً بیک گراؤنڈ
- `timeout` (سیکنڈز، بطورِ طے شدہ 1800): معیاد ختم ہونے پر بند کریں
- `pty` (bool): دستیاب ہونے پر pseudo-terminal میں چلائیں (صرف TTY والے CLIs، کوڈنگ ایجنٹس، ٹرمینل UIs)
- `host` (`sandbox | gateway | node`): کہاں اجرا کرنا ہے
- `security` (`deny | allowlist | full`): `gateway`/`node` کے لیے نفاذی موڈ
- `ask` (`off | on-miss | always`): `gateway`/`node` کے لیے منظوری پرامپٹس
- `node` (string): `host=node` کے لیے نوڈ آئی ڈی/نام
- `elevated` (bool): بلند اختیاراتی موڈ کی درخواست (گیٹ وے ہوسٹ)؛ `security=full` صرف تب لازمی ہوتا ہے جب elevated حل ہو کر `full` بنے

Notes:

- `host` بطورِ طے شدہ `sandbox` ہوتا ہے۔
- sandboxing بند ہونے پر `elevated` نظر انداز کیا جاتا ہے (exec پہلے ہی ہوسٹ پر چلتا ہے)۔
- `gateway`/`node` کی منظوریات `~/.openclaw/exec-approvals.json` کے ذریعے کنٹرول ہوتی ہیں۔
- `node` کے لیے جوڑا ہوا نوڈ درکار ہے (معاون ایپ یا ہیڈ لیس نوڈ ہوسٹ)۔
- اگر متعدد نوڈز دستیاب ہوں، تو ایک منتخب کرنے کے لیے `exec.node` یا `tools.exec.node` سیٹ کریں۔
- نان-ونڈوز ہوسٹس پر، exec سیٹ ہونے پر `SHELL` استعمال کرتا ہے؛ اگر `SHELL` `fish` ہو، تو fish سے غیر مطابقت رکھنے والی اسکرپٹس سے بچنے کے لیے `PATH` میں سے `bash` (یا `sh`) کو ترجیح دیتا ہے، پھر اگر دونوں موجود نہ ہوں تو `SHELL` پر واپس آتا ہے۔
- ہوسٹ اجرا (`gateway`/`node`) بائنری ہائی جیکنگ یا انجیکٹڈ کوڈ سے بچاؤ کے لیے `env.PATH` اور لوڈر اوور رائیڈز (`LD_*`/`DYLD_*`) کو مسترد کرتا ہے۔
- اہم: sandboxing **بطورِ طے شدہ بند** ہے۔ اگر sandboxing بند ہو، تو `host=sandbox` براہِ راست گیٹ وے ہوسٹ پر (بغیر کنٹینر) چلتا ہے اور **منظوریات درکار نہیں ہوتیں**۔ منظوریات لازم کرنے کے لیے `host=gateway` کے ساتھ چلائیں اور exec منظوریات کنفیگر کریں (یا sandboxing فعال کریں)۔

## Config

- `tools.exec.notifyOnExit` (بطورِ طے شدہ: true): true ہونے پر، بیک گراؤنڈ کیے گئے exec سیشنز ایک سسٹم ایونٹ قطار میں ڈالتے ہیں اور اختتام پر ہارٹ بیٹ کی درخواست کرتے ہیں۔
- `tools.exec.approvalRunningNoticeMs` (بطورِ طے شدہ: 10000): جب منظوری سے مشروط exec اس مدت سے زیادہ چلے تو ایک واحد “running” نوٹس جاری کریں (0 غیر فعال کرتا ہے)۔
- `tools.exec.host` (بطورِ طے شدہ: `sandbox`)
- `tools.exec.security` (بطورِ طے شدہ: sandbox کے لیے `deny`، اور گیٹ وے + نوڈ کے لیے `allowlist` جب غیر سیٹ ہو)
- `tools.exec.ask` (بطورِ طے شدہ: `on-miss`)
- `tools.exec.node` (بطورِ طے شدہ: unset)
- `tools.exec.pathPrepend`: exec رنز کے لیے `PATH` میں prepend کرنے والی ڈائریکٹریز کی فہرست۔
- `tools.exec.safeBins`: صرف-stdin محفوظ بائنریز جو صریح allowlist اندراجات کے بغیر چل سکتی ہیں۔

Example:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH handling

- `host=gateway`: آپ کے لاگ اِن شیل کے `PATH` کو exec ماحول میں ضم کرتا ہے۔ ہوسٹ اجرا کے لیے `env.PATH` اوور رائیڈز مسترد کی جاتی ہیں۔ خود ڈیمَن پھر بھی کم سے کم `PATH` کے ساتھ چلتا ہے:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: کنٹینر کے اندر `sh -lc` (لاگ اِن شیل) چلاتا ہے، اس لیے `/etc/profile` ممکن ہے `PATH` ری سیٹ کرے۔ OpenClaw پروفائل سورسنگ کے بعد ایک اندرونی env var کے ذریعے `env.PATH` prepend کرتا ہے (بغیر شیل انٹرپولیشن)؛ `tools.exec.pathPrepend` یہاں بھی لاگو ہوتا ہے۔
- `host=node`: صرف وہی غیر بلاک شدہ env اوور رائیڈز جو آپ بھیجتے ہیں نوڈ کو بھیجے جاتے ہیں۔ ہوسٹ اجرا کے لیے `env.PATH` اوور رائیڈز مسترد کی جاتی ہیں۔ ہیڈ لیس نوڈ ہوسٹس `PATH` کو صرف تب قبول کرتے ہیں جب یہ نوڈ ہوسٹ PATH کو prepend کرے (متبادل نہیں)۔ macOS نوڈز `PATH` اوور رائیڈز کو مکمل طور پر خارج کر دیتے ہیں۔

ہر ایجنٹ کے لیے نوڈ بائنڈنگ (کنفیگ میں ایجنٹ لسٹ انڈیکس استعمال کریں):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

کنٹرول UI: Nodes ٹیب میں انہی سیٹنگز کے لیے ایک چھوٹا “Exec node binding” پینل شامل ہے۔

## Session overrides (`/exec`)

`/exec` استعمال کریں تاکہ **فی سیشن** `host`, `security`, `ask`, اور `node` کے ڈیفالٹس سیٹ کیے جا سکیں۔
موجودہ قدروں کو دکھانے کے لیے بغیر آرگیومنٹس کے `/exec` بھیجیں۔

Example:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Authorization model

`/exec` صرف **مجاز ارسال کنندگان** کے لیے معتبر ہے (چینل allowlists/جوڑی بنانا اور `commands.useAccessGroups`)۔
یہ **صرف سیشن اسٹیٹ** کو اپڈیٹ کرتا ہے اور کنفیگ نہیں لکھتا۔ exec کو سختی سے غیر فعال کرنے کے لیے، ٹول پالیسی کے ذریعے انکار کریں
(`tools.deny: ["exec"]` یا فی ایجنٹ)۔ ہوسٹ منظوریات بدستور لاگو رہتی ہیں جب تک کہ آپ صراحتاً
`security=full` اور `ask=off` سیٹ نہ کریں۔

## Exec approvals (companion app / node host)

Sandboxed ایجنٹس گیٹ وے یا نوڈ ہوسٹ پر `exec` کے چلنے سے پہلے فی درخواست منظوری لازم کر سکتے ہیں۔
پالیسی، allowlist، اور UI فلو کے لیے [Exec approvals](/tools/exec-approvals) دیکھیں۔

جب منظوریات درکار ہوں، تو exec ٹول فوراً `status: "approval-pending"` اور ایک منظوری آئی ڈی کے ساتھ واپس آتا ہے۔
منظور (یا مسترد / وقت ختم) ہونے پر، Gateway سسٹم ایونٹس (`Exec finished` / `Exec denied`) جاری کرتا ہے۔
اگر کمانڈ `tools.exec.approvalRunningNoticeMs` کے بعد بھی چل رہی ہو، تو ایک واحد `Exec running` نوٹس جاری کیا جاتا ہے۔

## Allowlist + safe bins

Allowlist نفاذ **صرف حل شدہ بائنری راستوں** سے میل کھاتا ہے (basename میچ نہیں)۔ جب
`security=allowlist` ہو، تو شیل کمانڈز خودکار طور پر صرف اسی صورت اجازت پاتی ہیں جب ہر پائپ لائن حصہ
allowlisted ہو یا safe bin ہو۔ چیننگ (`;`, `&&`, `||`) اور ری ڈائریکشنز
allowlist موڈ میں مسترد کر دی جاتی ہیں۔

## Examples

Foreground:

```json
{ "tool": "exec", "command": "ls -la" }
```

Background + poll:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Send keys (tmux-style):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Submit (صرف CR بھیجیں):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste (بطورِ طے شدہ bracketed):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (تجرباتی)

`apply_patch`، `exec` کا ایک ذیلی ٹول ہے جو منظم کثیر-فائل ترامیم کے لیے ہے۔
اسے صراحتاً فعال کریں:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Notes:

- صرف OpenAI/OpenAI Codex ماڈلز کے لیے دستیاب۔
- ٹول پالیسی بدستور لاگو رہتی ہے؛ `allow: ["exec"]` بالواسطہ طور پر `apply_patch` کی اجازت دیتا ہے۔
- کنفیگ `tools.exec.applyPatch` کے تحت موجود ہے۔
