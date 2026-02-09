---
summary: "OpenClaw میں OAuth: ٹوکن کا تبادلہ، ذخیرہ کاری، اور متعدد اکاؤنٹس کے پیٹرنز"
read_when:
  - آپ OpenClaw میں OAuth کو ابتدا سے انتہا تک سمجھنا چاہتے ہیں
  - آپ کو ٹوکن کے باطل ہونے / لاگ آؤٹ کے مسائل درپیش ہوں
  - آپ setup-token یا OAuth کی تصدیقی فلو چاہتے ہوں
  - آپ متعدد اکاؤنٹس یا پروفائل روٹنگ چاہتے ہوں
title: "OAuth"
---

# OAuth

13. Anthropic سبسکرپشنز کے لیے **setup-token** فلو استعمال کریں۔ 14. یہ صفحہ وضاحت کرتا ہے: 15. OpenClaw **provider plugins** کو بھی سپورٹ کرتا ہے جو اپنا OAuth یا API‑key فلو فراہم کرتے ہیں۔

- OAuth **token exchange** کیسے کام کرتا ہے (PKCE)
- ٹوکنز کہاں **محفوظ** ہوتے ہیں (اور کیوں)
- **متعدد اکاؤنٹس** کو کیسے سنبھالا جائے (پروفائلز + فی سیشن اووررائیڈز)

16. انہیں اس طرح چلائیں: 17. OAuth فراہم کنندگان عام طور پر لاگ اِن/ریفریش فلو کے دوران **نیا refresh token** جاری کرتے ہیں۔

```bash
openclaw models auth login --provider <id>
```

## ٹوکن سنک (یہ کیوں موجود ہے)

18. کچھ فراہم کنندگان (یا OAuth کلائنٹس) ایک ہی صارف/ایپ کے لیے نیا ٹوکن جاری ہونے پر پرانے refresh tokens کو غیر مؤثر کر سکتے ہیں۔ 19. مذکورہ تمام چیزیں `$OPENCLAW_STATE_DIR` (state dir override) کا بھی احترام کرتی ہیں۔

عملی علامت:

- آپ OpenClaw کے ذریعے _اور_ Claude Code / Codex CLI کے ذریعے لاگ اِن کرتے ہیں → بعد میں ان میں سے کوئی ایک بے ترتیبی سے “لاگ آؤٹ” ہو جاتا ہے

اس کو کم کرنے کے لیے، OpenClaw `auth-profiles.json` کو **token sink** کے طور پر استعمال کرتا ہے:

- رَن ٹائم اسناد **ایک جگہ** سے پڑھتا ہے
- ہم متعدد پروفائلز رکھ سکتے ہیں اور انہیں متعین انداز میں روٹ کر سکتے ہیں

## ذخیرہ کاری (ٹوکن کہاں رہتے ہیں)

راز **per-agent** محفوظ ہوتے ہیں:

- Auth پروفائلز (OAuth + API keys): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- رَن ٹائم کیش (خودکار طور پر منظم؛ ترمیم نہ کریں): `~/.openclaw/agents/<agentId>/agent/auth.json`

لیگیسی صرف-درآمد فائل (اب بھی معاون، مگر مرکزی اسٹور نہیں):

- `~/.openclaw/credentials/oauth.json` (پہلی بار استعمال پر `auth-profiles.json` میں درآمد)

20. مکمل حوالہ: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys) 26. مکمل حوالہ: [/gateway/configuration](/gateway/configuration#auth-storage-oauth--api-keys)

## Anthropic setup-token (subscription auth)

کسی بھی مشین پر `claude setup-token` چلائیں، پھر اسے OpenClaw میں پیسٹ کریں:

```bash
openclaw models auth setup-token --provider anthropic
```

اگر آپ نے ٹوکن کہیں اور بنایا ہے تو اسے دستی طور پر پیسٹ کریں:

```bash
openclaw models auth paste-token --provider anthropic
```

تصدیق کریں:

```bash
openclaw models status
```

## OAuth تبادلہ (لاگ اِن کیسے کام کرتا ہے)

OpenClaw کے انٹرایکٹو لاگ اِن فلو `@mariozechner/pi-ai` میں نافذ ہیں اور وِزارڈز/کمانڈز کے ساتھ جڑے ہوئے ہیں۔

### Anthropic (Claude Pro/Max) setup-token

فلو کی ساخت:

1. `claude setup-token` چلائیں
2. ٹوکن OpenClaw میں پیسٹ کریں
3. اسے ٹوکن auth پروفائل کے طور پر محفوظ کریں (بغیر ریفریش)

وِزارڈ کا راستہ `openclaw onboard` → auth انتخاب `setup-token` (Anthropic) ہے۔

### OpenAI Codex (ChatGPT OAuth)

فلو کی ساخت (PKCE):

1. PKCE verifier/challenge + بے ترتیب `state` تیار کریں
2. `https://auth.openai.com/oauth/authorize?...` کھولیں
3. `http://127.0.0.1:1455/auth/callback` پر کال بیک کیپچر کرنے کی کوشش کریں
4. اگر کال بیک بائنڈ نہ ہو سکے (یا آپ ریموٹ/ہیڈلیس ہوں) تو ری ڈائریکٹ URL/کوڈ پیسٹ کریں
5. `https://auth.openai.com/oauth/token` پر ایکسچینج کریں
6. ایکسس ٹوکن سے `accountId` نکالیں اور `{ access, refresh, expires, accountId }` محفوظ کریں

وِزارڈ کا راستہ `openclaw onboard` → auth انتخاب `openai-codex` ہے۔

## ریفریش + میعاد

پروفائلز ایک `expires` ٹائم اسٹیمپ محفوظ کرتے ہیں۔

رَن ٹائم پر:

- اگر `expires` مستقبل میں ہو → محفوظ شدہ ایکسس ٹوکن استعمال کریں
- اگر میعاد ختم ہو چکی ہو → (فائل لاک کے تحت) ریفریش کریں اور محفوظ شدہ اسناد اووررائٹ کریں

ریفریش فلو خودکار ہے؛ عموماً آپ کو ٹوکنز دستی طور پر سنبھالنے کی ضرورت نہیں ہوتی۔

## متعدد اکاؤنٹس (پروفائلز) + روٹنگ

دو پیٹرنز:

### 1. ترجیحی: علیحدہ ایجنٹس

اگر آپ چاہتے ہیں کہ “ذاتی” اور “کام” کبھی باہم تعامل نہ کریں، تو علیحدہ ایجنٹس استعمال کریں (علیحدہ سیشنز + اسناد + ورک اسپیس):

```bash
openclaw agents add work
openclaw agents add personal
```

پھر ہر ایجنٹ کے لیے auth کنفیگر کریں (وِزارڈ) اور چیٹس کو درست ایجنٹ کی طرف روٹ کریں۔

### 2. جدید: ایک ایجنٹ میں متعدد پروفائلز

`auth-profiles.json` ایک ہی فراہم کنندہ کے لیے متعدد پروفائل IDs کی حمایت کرتا ہے۔

یہ منتخب کریں کہ کون سا پروفائل استعمال ہو:

- عالمی طور پر کنفیگ آرڈرنگ کے ذریعے (`auth.order`)
- فی سیشن `/model ...@<profileId>` کے ذریعے

مثال (سیشن اووررائیڈ):

- `/model Opus@anthropic:work`

یہ دیکھنے کے لیے کہ کون سے پروفائل IDs موجود ہیں:

- `openclaw channels list --json` ( `auth[]` دکھاتا ہے)

متعلقہ دستاویزات:

- [/concepts/model-failover](/concepts/model-failover) (روٹیشن + کول ڈاؤن قواعد)
- [/tools/slash-commands](/tools/slash-commands) (کمانڈ سطح)
