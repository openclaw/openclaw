---
summary: "OpenClaw کس طرح auth پروفائلز کو گھماتا ہے اور ماڈلز کے درمیان فال بیک کرتا ہے"
read_when:
  - auth پروفائل روٹیشن، کول ڈاؤنز، یا ماڈل فال بیک رویّے کی تشخیص کرتے وقت
  - auth پروفائلز یا ماڈلز کے لیے فال بیک قواعد کو اپ ڈیٹ کرتے وقت
title: "ماڈل فال بیک"
---

# ماڈل فال بیک

OpenClaw ناکامیوں کو دو مراحل میں سنبھالتا ہے:

1. **Auth پروفائل روٹیشن** موجودہ فراہم کنندہ کے اندر۔
2. **ماڈل فال بیک** `agents.defaults.model.fallbacks` میں اگلے ماڈل تک۔

یہ دستاویز رن ٹائم قواعد اور اُن کے پس منظر میں موجود ڈیٹا کی وضاحت کرتی ہے۔

## Auth اسٹوریج (کلیدیں + OAuth)

OpenClaw **auth پروفائلز** استعمال کرتا ہے، جو API کلیدوں اور OAuth ٹوکنز دونوں کے لیے ہوتے ہیں۔

- راز `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` میں محفوظ ہوتے ہیں (لیگیسی: `~/.openclaw/agent/auth-profiles.json`)۔
- کنفیگ `auth.profiles` / `auth.order` صرف **میٹاڈیٹا + روٹنگ** کے لیے ہیں (کوئی راز نہیں)۔
- لیگیسی صرف-امپورٹ OAuth فائل: `~/.openclaw/credentials/oauth.json` (پہلی بار استعمال پر `auth-profiles.json` میں امپورٹ ہوتی ہے)۔

مزید تفصیل: [/concepts/oauth](/concepts/oauth)

اسناد کی اقسام:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` for some providers)

## پروفائل IDs

OAuth لاگ اِن الگ الگ پروفائلز بناتا ہے تاکہ متعدد اکاؤنٹس ساتھ رہ سکیں۔

- ڈیفالٹ: `provider:default` جب ای میل دستیاب نہ ہو۔
- ای میل کے ساتھ OAuth: `provider:<email>` (مثال کے طور پر `google-antigravity:user@gmail.com`)۔

پروفائلز `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` میں `profiles` کے تحت محفوظ ہوتے ہیں۔

## روٹیشن کی ترتیب

جب کسی فراہم کنندہ کے پاس متعدد پروفائلز ہوں، OpenClaw اس ترتیب کا انتخاب کرتا ہے:

1. **واضح کنفیگ**: `auth.order[provider]` (اگر سیٹ ہو)۔
2. **کنفیگر شدہ پروفائلز**: `auth.profiles` جو فراہم کنندہ کے مطابق فلٹر ہوں۔
3. **محفوظ شدہ پروفائلز**: فراہم کنندہ کے لیے `auth-profiles.json` میں اندراجات۔

اگر کوئی واضح ترتیب کنفیگر نہ ہو تو OpenClaw راؤنڈ-روبن ترتیب استعمال کرتا ہے:

- **پرائمری کلید:** پروفائل کی قسم (**OAuth، API کلیدوں سے پہلے**)۔
- **سیکنڈری کلید:** `usageStats.lastUsed` (ہر قسم کے اندر قدیم ترین پہلے)۔
- **کول ڈاؤن/غیرفعال پروفائلز** کو آخر میں منتقل کیا جاتا ہے، جلد ترین میعاد ختم ہونے کی ترتیب سے۔

### سیشن اسٹکنس (کیچ-فرینڈلی)

OpenClaw **pins the chosen auth profile per session** to keep provider caches warm.
22. یہ **ہر درخواست پر** روٹیٹ نہیں کرتا۔ The pinned profile is reused until:

- سیشن ری سیٹ نہ ہو (`/new` / `/reset`)
- کوئی کمپیکشن مکمل نہ ہو (کمپیکشن کاؤنٹ میں اضافہ)
- پروفائل کول ڈاؤن میں یا غیرفعال نہ ہو

`/model …@<profileId>` کے ذریعے دستی انتخاب اس سیشن کے لیے **یوزر اووررائیڈ** سیٹ کرتا ہے
اور نیا سیشن شروع ہونے تک خودکار روٹیشن نہیں ہوتی۔

Auto‑pinned profiles (selected by the session router) are treated as a **preference**:
they are tried first, but OpenClaw may rotate to another profile on rate limits/timeouts.
User‑pinned profiles stay locked to that profile; if it fails and model fallbacks
are configured, OpenClaw moves to the next model instead of switching profiles.

### OAuth کیوں “گم شدہ” محسوس ہو سکتا ہے

If you have both an OAuth profile and an API key profile for the same provider, round‑robin can switch between them across messages unless pinned. To force a single profile:

- `auth.order[provider] = ["provider:profileId"]` کے ساتھ پن کریں، یا
- `/model …` کے ذریعے فی-سیشن اووررائیڈ استعمال کریں جس میں پروفائل اووررائیڈ ہو (جب آپ کی UI/چیٹ سطح اس کی حمایت کرے)۔

## کول ڈاؤنز

When a profile fails due to auth/rate‑limit errors (or a timeout that looks
like rate limiting), OpenClaw marks it in cooldown and moves to the next profile.
Format/invalid‑request errors (for example Cloud Code Assist tool call ID
validation failures) are treated as failover‑worthy and use the same cooldowns.

کول ڈاؤنز ایکسپونینشل بیک آف استعمال کرتے ہیں:

- 1 منٹ
- 5 منٹ
- 25 منٹ
- 1 گھنٹہ (حد)

حالت `auth-profiles.json` میں `usageStats` کے تحت محفوظ ہوتی ہے:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## بلنگ کی وجہ سے غیرفعالی

Billing/credit failures (for example “insufficient credits” / “credit balance too low”) are treated as failover‑worthy, but they’re usually not transient. Instead of a short cooldown, OpenClaw marks the profile as **disabled** (with a longer backoff) and rotates to the next profile/provider.

حالت `auth-profiles.json` میں محفوظ ہوتی ہے:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

ڈیفالٹس:

- بلنگ بیک آف **5 گھنٹے** سے شروع ہوتا ہے، ہر بلنگ ناکامی پر دگنا ہوتا ہے، اور **24 گھنٹے** پر محدود ہو جاتا ہے۔
- اگر پروفائل **24 گھنٹے** تک ناکام نہ ہو تو بیک آف کاؤنٹرز ری سیٹ ہو جاتے ہیں (کنفیگریبل)۔

## ماڈل فال بیک

23. اگر کسی فراہم کنندہ کے تمام پروفائلز ناکام ہو جائیں، تو OpenClaw اگلے ماڈل پر منتقل ہو جاتا ہے جو
    `agents.defaults.model.fallbacks` میں ہے۔ This applies to auth failures, rate limits, and
    timeouts that exhausted profile rotation (other errors do not advance fallback).

جب کوئی رَن ماڈل اووررائیڈ (ہُکس یا CLI) کے ساتھ شروع ہو، تو فال بیکس پھر بھی
کسی بھی کنفیگر شدہ فال بیکس آزمانے کے بعد `agents.defaults.model.primary` پر ختم ہوتے ہیں۔

## متعلقہ کنفیگ

دیکھیں [Gateway کنفیگریشن](/gateway/configuration) برائے:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` روٹنگ

وسیع تر ماڈل انتخاب اور فال بیک کے جائزے کے لیے [Models](/concepts/models) دیکھیں۔
