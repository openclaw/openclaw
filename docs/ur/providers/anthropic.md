---
summary: "OpenClaw میں API کلیدوں یا setup-token کے ذریعے Anthropic Claude استعمال کریں"
read_when:
  - آپ OpenClaw میں Anthropic ماڈلز استعمال کرنا چاہتے ہیں
  - آپ API کلیدوں کے بجائے setup-token چاہتے ہیں
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic **Claude** ماڈل فیملی بناتا ہے اور API کے ذریعے رسائی فراہم کرتا ہے۔
OpenClaw میں آپ API کی یا **setup-token** کے ساتھ توثیق کر سکتے ہیں۔

## Option A: Anthropic API key

**بہترین برائے:** معیاری API رسائی اور استعمال پر مبنی بلنگ۔
Anthropic Console میں اپنی API کی بنائیں۔

### CLI setup

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config snippet

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt caching (Anthropic API)

OpenClaw Anthropic کی پرامپٹ کیشنگ خصوصیت کو سپورٹ کرتا ہے۔ یہ **صرف API** کے لیے ہے؛ سبسکرپشن توثیق کیش سیٹنگز کو تسلیم نہیں کرتی۔

### Configuration

اپنی ماڈل کنفیگ میں `cacheRetention` پیرامیٹر استعمال کریں:

| Value   | Cache Duration | Description                                       |
| ------- | -------------- | ------------------------------------------------- |
| `none`  | No caching     | prompt caching کو غیر فعال کریں                   |
| `short` | 5 minutes      | API Key تصدیق کے لیے بطورِ طے شدہ                 |
| `long`  | 1 hour         | توسیعی cache (beta flag درکار) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Defaults

Anthropic API Key توثیق استعمال کرتے وقت، OpenClaw خودکار طور پر تمام Anthropic ماڈلز کے لیے `cacheRetention: "short"` (5 منٹ کیش) لاگو کرتا ہے۔ آپ اپنی کنفیگ میں واضح طور پر `cacheRetention` سیٹ کر کے اسے اووررائیڈ کر سکتے ہیں۔

### Legacy parameter

پرانا `cacheControlTtl` پیرامیٹر پسماندہ مطابقت کے لیے اب بھی سپورٹ کیا جاتا ہے:

- `"5m"`، `short` سے میپ ہوتا ہے
- `"1h"`، `long` سے میپ ہوتا ہے

ہم نئے `cacheRetention` پیرامیٹر پر منتقلی کی سفارش کرتے ہیں۔

OpenClaw، Anthropic API درخواستوں کے لیے `extended-cache-ttl-2025-04-11` beta flag شامل کرتا ہے؛ اگر آپ فراہم کنندہ کے ہیڈرز اووررائیڈ کریں تو اسے برقرار رکھیں (دیکھیں [/gateway/configuration](/gateway/configuration))۔

## Option B: Claude setup-token

**بہترین انتخاب:** اپنی Claude سبسکرپشن استعمال کرنے کے لیے۔

### setup-token کہاں سے حاصل کریں

Setup-token **Claude Code CLI** کے ذریعے بنائے جاتے ہیں، Anthropic Console کے ذریعے نہیں۔ آپ اسے **کسی بھی مشین** پر چلا سکتے ہیں:

```bash
claude setup-token
```

ٹوکن کو OpenClaw میں پیسٹ کریں (وزارڈ: **Anthropic token (paste setup-token)**)، یا اسے گیٹ وے ہوسٹ پر چلائیں:

```bash
openclaw models auth setup-token --provider anthropic
```

اگر آپ نے ٹوکن کسی مختلف مشین پر بنایا ہے تو اسے پیسٹ کریں:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI setup (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Config snippet (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notes

- `claude setup-token` کے ساتھ setup-token بنائیں اور پیسٹ کریں، یا گیٹ وے ہوسٹ پر `openclaw models auth setup-token` چلائیں۔
- اگر Claude سبسکرپشن پر “OAuth token refresh failed …” نظر آئے تو setup-token کے ساتھ دوبارہ توثیق کریں۔ [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription) دیکھیں۔
- تصدیق کی تفصیلات اور دوبارہ استعمال کے قواعد [/concepts/oauth](/concepts/oauth) میں ہیں۔

## Troubleshooting

**401 errors / ٹوکن اچانک غیر معتبر**

- Claude سبسکرپشن کی توثیق ختم ہو سکتی ہے یا منسوخ کی جا سکتی ہے۔ `claude setup-token` دوبارہ چلائیں
  اور اسے **gateway host** میں پیسٹ کریں۔
- اگر Claude CLI لاگ اِن کسی مختلف مشین پر موجود ہے تو گیٹ وے ہوسٹ پر
  `openclaw models auth paste-token --provider anthropic` استعمال کریں۔

**No API key found for provider "anthropic"**

- توثیق **ہر ایجنٹ کے لیے** ہوتی ہے۔ نئے ایجنٹس مرکزی ایجنٹ کی کیز وراثت میں نہیں لیتے۔
- اس ایجنٹ کے لیے onboarding دوبارہ چلائیں، یا گیٹ وے ہوسٹ پر setup-token / API کلید پیسٹ کریں، پھر `openclaw models status` کے ساتھ تصدیق کریں۔

**No credentials found for profile `anthropic:default`**

- کون سا auth پروفائل فعال ہے یہ دیکھنے کے لیے `openclaw models status` چلائیں۔
- onboarding دوبارہ چلائیں، یا اس پروفائل کے لیے setup-token / API کلید پیسٹ کریں۔

**No available auth profile (all in cooldown/unavailable)**

- `openclaw models status --json` میں `auth.unusableProfiles` چیک کریں۔
- ایک اور Anthropic پروفائل شامل کریں یا cooldown ختم ہونے کا انتظار کریں۔

مزید: [/gateway/troubleshooting](/gateway/troubleshooting) اور [/help/faq](/help/faq)۔
