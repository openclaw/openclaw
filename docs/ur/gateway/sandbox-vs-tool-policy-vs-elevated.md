---
title: Sandbox vs Tool Policy vs Elevated
summary: "یہ کیوں کوئی ٹول بلاک ہوا: سینڈباکس رَن ٹائم، ٹول اجازت/ممانعت پالیسی، اور ایلیویٹڈ exec گیٹس"
read_when: "جب آپ کو 'sandbox jail' کا سامنا ہو یا کسی ٹول/ایلیویٹڈ انکار کو دیکھیں اور یہ جاننا چاہیں کہ کون سی درست کنفیگ کلید تبدیل کرنی ہے۔"
status: active
---

# Sandbox vs Tool Policy vs Elevated

OpenClaw میں تین باہم متعلق (لیکن مختلف) کنٹرولز ہیں:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) یہ طے کرتا ہے کہ **ٹولز کہاں چلتے ہیں** (Docker بمقابلہ ہوسٹ)۔
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) یہ طے کرتی ہے کہ **کون سے ٹولز دستیاب/اجازت یافتہ ہیں**۔
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) ایک **صرف-exec فرار راستہ** ہے تاکہ سینڈباکس میں ہونے کے باوجود ہوسٹ پر چلایا جا سکے۔

## Quick debug

یہ دیکھنے کے لیے انسپیکٹر استعمال کریں کہ OpenClaw _حقیقت میں_ کیا کر رہا ہے:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

یہ پرنٹ کرتا ہے:

- مؤثر سینڈباکس موڈ/اسکوپ/ورک اسپیس رسائی
- آیا سیشن اس وقت سینڈباکس میں ہے یا نہیں (مین بمقابلہ نان-مین)
- مؤثر سینڈباکس ٹول اجازت/ممانعت (اور یہ کہ آیا یہ ایجنٹ/گلوبل/ڈیفالٹ سے آیا ہے)
- ایلیویٹڈ گیٹس اور فکس-اِٹ کلید کے راستے

## Sandbox: ٹولز کہاں چلتے ہیں

Sandboxing کو `agents.defaults.sandbox.mode` کے ذریعے کنٹرول کیا جاتا ہے:

- `"off"`: ہر چیز ہوسٹ پر چلتی ہے۔
- `"non-main"`: صرف نان-مین سیشنز سینڈباکس ہوتے ہیں (گروپس/چینلز میں عام “حیرت”)۔
- `"all"`: ہر چیز سینڈباکس میں ہوتی ہے۔

مکمل میٹرکس (اسکوپ، ورک اسپیس ماؤنٹس، امیجز) کے لیے [Sandboxing](/gateway/sandboxing) دیکھیں۔

### Bind mounts (سکیورٹی فوری جانچ)

- `docker.binds` سینڈباکس فائل سسٹم کو _چیر_ دیتا ہے: جو کچھ آپ ماؤنٹ کرتے ہیں وہ کنٹینر کے اندر آپ کے مقرر کردہ موڈ (`:ro` یا `:rw`) کے ساتھ نظر آتا ہے۔
- اگر آپ موڈ چھوڑ دیں تو ڈیفالٹ read-write ہوتا ہے؛ سورس/سیcrets کے لیے `:ro` کو ترجیح دیں۔
- `scope: "shared"` فی-ایجنٹ بائنڈز کو نظر انداز کرتا ہے (صرف گلوبل بائنڈز لاگو ہوتے ہیں)۔
- `/var/run/docker.sock` کو بائنڈ کرنا عملی طور پر سینڈباکس کو ہوسٹ کنٹرول دے دیتا ہے؛ یہ صرف جان بوجھ کر کریں۔
- ورک اسپیس رسائی (`workspaceAccess: "ro"`/`"rw"`) بائنڈ موڈز سے آزاد ہے۔

## Tool policy: کون سے ٹولز موجود/قابلِ کال ہیں

دو سطحیں اہم ہیں:

- **Tool profile**: `tools.profile` اور `agents.list[].tools.profile` (بنیادی اجازت فہرست)
- **Provider tool profile**: `tools.byProvider[provider].profile` اور `agents.list[].tools.byProvider[provider].profile`
- **Global/per-agent tool policy**: `tools.allow`/`tools.deny` اور `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider tool policy**: `tools.byProvider[provider].allow/deny` اور `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox tool policy** (صرف اس وقت لاگو ہوتی ہے جب سینڈباکس میں ہوں): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` اور `agents.list[].tools.sandbox.tools.*`

رولز آف تھمب:

- `deny` ہمیشہ غالب رہتا ہے۔
- اگر `allow` خالی نہ ہو تو باقی سب کو بلاک سمجھا جاتا ہے۔
- ٹول پالیسی حتمی رکاوٹ ہے: `/exec` کسی ممنوعہ `exec` ٹول کو اووررائیڈ نہیں کر سکتا۔
- 41. `/exec` صرف مجاز بھیجنے والوں کے لیے سیشن ڈیفالٹس تبدیل کرتا ہے؛ یہ ٹول تک رسائی فراہم نہیں کرتا۔
  42. Provider ٹول کیز یا تو `provider` (مثلاً `google-antigravity`) یا `provider/model` (مثلاً `openai/gpt-5.2`) قبول کرتی ہیں۔

### Tool groups (مختصر نام)

ٹول پالیسیز (گلوبل، ایجنٹ، سینڈباکس) `group:*` اندراجات کی حمایت کرتی ہیں جو متعدد ٹولز میں پھیل جاتے ہیں:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

دستیاب گروپس:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: تمام بلٹ اِن OpenClaw ٹولز (provider پلگ اِنز شامل نہیں)

## Elevated: صرف exec کے لیے “ہوسٹ پر چلائیں”

Elevated **اضافی ٹولز فراہم نہیں کرتا**؛ یہ صرف `exec` کو متاثر کرتا ہے۔

- اگر آپ سینڈباکس میں ہیں تو `/elevated on` (یا `exec` کے ساتھ `elevated: true`) ہوسٹ پر چلتا ہے (منظوریاں پھر بھی لاگو ہو سکتی ہیں)۔
- سیشن کے لیے exec منظوریوں کو چھوڑنے کے لیے `/elevated full` استعمال کریں۔
- اگر آپ پہلے ہی براہِ راست چل رہے ہیں تو Elevated عملی طور پر no-op ہے (پھر بھی گیٹڈ)۔
- Elevated **Skill-اسکوپڈ نہیں** ہے اور **ٹول اجازت/ممانعت کو اووررائیڈ نہیں** کرتا۔
- 43. `/exec` elevated سے الگ ہے۔ 44. یہ صرف مجاز بھیجنے والوں کے لیے فی-سیشن exec ڈیفالٹس ایڈجسٹ کرتا ہے۔

گیٹس:

- فعال کرنا: `tools.elevated.enabled` (اور اختیاری طور پر `agents.list[].tools.elevated.enabled`)
- 45. Sender allowlists: `tools.elevated.allowFrom.<provider>46. ` (اور اختیاری طور پر `agents.list[].tools.elevated.allowFrom.<provider>47. `)

دیکھیں [Elevated Mode](/tools/elevated)۔

## عام “sandbox jail” کے حل

### “Tool X sandbox tool policy کے ذریعے بلاک ہے”

فکس-اِٹ کیز (ایک منتخب کریں):

- سینڈباکس غیر فعال کریں: `agents.defaults.sandbox.mode=off` (یا فی-ایجنٹ `agents.list[].sandbox.mode=off`)
- سینڈباکس کے اندر ٹول کی اجازت دیں:
  - اسے `tools.sandbox.tools.deny` سے ہٹا دیں (یا فی-ایجنٹ `agents.list[].tools.sandbox.tools.deny`)
  - یا اسے `tools.sandbox.tools.allow` میں شامل کریں (یا فی-ایجنٹ allow)

### “مجھے لگا یہ مین ہے، یہ سینڈباکس کیوں ہے؟”

48. `"non-main"` موڈ میں، group/channel کیز _main_ نہیں ہوتیں۔ 49. مین سیشن کی استعمال کریں (جو `sandbox explain` کے ذریعے دکھائی جاتی ہے) یا موڈ کو `"off"` پر سوئچ کریں۔
