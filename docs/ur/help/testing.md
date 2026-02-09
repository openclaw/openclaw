---
summary: "ٹیسٹنگ کٹ: یونٹ/ای2ای/لائیو سوئٹس، Docker رَنرز، اور ہر ٹیسٹ کیا کور کرتا ہے"
read_when:
  - مقامی طور پر یا CI میں ٹیسٹس چلانا
  - ماڈل/فراہم کنندہ کے بگز کے لیے ریگریشنز شامل کرنا
  - گیٹ وے + ایجنٹ کے رویّے کی ڈیبگنگ
title: "ٹیسٹنگ"
---

# ٹیسٹنگ

OpenClaw میں تین Vitest سوئٹس (یونٹ/انٹیگریشن، e2e، لائیو) اور Docker رَنرز کا ایک مختصر سیٹ شامل ہے۔

یہ دستاویز “ہم کیسے ٹیسٹ کرتے ہیں” کی رہنمائی ہے:

- ہر سوئٹ کیا کور کرتا ہے (اور جان بوجھ کر کیا _کور نہیں_ کرتا)
- عام ورک فلو کے لیے کون سی کمانڈز چلانی ہیں (لوکل، پری-پُش، ڈیبگنگ)
- لائیو ٹیسٹس اسناد کیسے دریافت کرتے ہیں اور ماڈلز/فراہم کنندگان کیسے منتخب ہوتے ہیں
- حقیقی دنیا کے ماڈل/فراہم کنندہ مسائل کے لیے ریگریشنز کیسے شامل کریں

## فوری آغاز

زیادہ تر دنوں میں:

- مکمل گیٹ (پُش سے پہلے متوقع): `pnpm build && pnpm check && pnpm test`

جب آپ ٹیسٹس میں تبدیلی کریں یا اضافی اعتماد درکار ہو:

- کوریج گیٹ: `pnpm test:coverage`
- E2E سوئٹ: `pnpm test:e2e`

جب حقیقی فراہم کنندگان/ماڈلز کی ڈیبگنگ ہو (حقیقی اسناد درکار):

- لائیو سوئٹ (ماڈلز + گیٹ وے ٹول/امیج پروبز): `pnpm test:live`

مشورہ: جب صرف ایک ناکام کیس درکار ہو تو نیچے بیان کردہ allowlist ماحولیاتی متغیرات کے ذریعے لائیو ٹیسٹس کو محدود کرنا بہتر ہے۔

## ٹیسٹ سوئٹس (کہاں کیا چلتا ہے)

سوئٹس کو “حقیقت پسندی میں اضافہ” (اور عدم استحکام/لاگت میں اضافہ) کے طور پر دیکھیں:

### یونٹ / انٹیگریشن (ڈیفالٹ)

- کمانڈ: `pnpm test`
- کنفیگ: `vitest.config.ts`
- فائلیں: `src/**/*.test.ts`
- دائرۂ کار:
  - خالص یونٹ ٹیسٹس
  - اِن-پروسیس انٹیگریشن ٹیسٹس (گیٹ وے تصدیق، روٹنگ، ٹولنگ، پارسنگ، کنفیگ)
  - معلوم بگز کے لیے متعین ریگریشنز
- توقعات:
  - CI میں چلتا ہے
  - حقیقی کلیدیں درکار نہیں
  - تیز اور مستحکم ہونا چاہیے

### E2E (گیٹ وے اسموک)

- کمانڈ: `pnpm test:e2e`
- کنفیگ: `vitest.e2e.config.ts`
- فائلیں: `src/**/*.e2e.test.ts`
- دائرۂ کار:
  - ملٹی-انسٹینس گیٹ وے اینڈ-ٹو-اینڈ رویّہ
  - WebSocket/HTTP سطحیں، نوڈ پیئرنگ، اور بھاری نیٹ ورکنگ
- توقعات:
  - CI میں چلتا ہے (جب پائپ لائن میں فعال ہو)
  - حقیقی کلیدیں درکار نہیں
  - یونٹ ٹیسٹس کے مقابلے میں زیادہ اجزاء (سست ہو سکتا ہے)

### لائیو (حقیقی فراہم کنندگان + حقیقی ماڈلز)

- کمانڈ: `pnpm test:live`
- کنفیگ: `vitest.live.config.ts`
- فائلیں: `src/**/*.live.test.ts`
- ڈیفالٹ: `pnpm test:live` کے ذریعے **فعال** (`OPENCLAW_LIVE_TEST=1` سیٹ کرتا ہے)
- دائرۂ کار:
  - “کیا یہ فراہم کنندہ/ماڈل آج حقیقی اسناد کے ساتھ واقعی کام کرتا ہے؟”
  - فراہم کنندہ فارمیٹ تبدیلیاں، ٹول-کالنگ کی نزاکتیں، تصدیقی مسائل، اور ریٹ لمٹ رویّہ پکڑنا
- توقعات:
  - ڈیزائن کے لحاظ سے CI-مستحکم نہیں (حقیقی نیٹ ورکس، حقیقی پالیسیز، کوٹاز، آؤٹیجز)
  - لاگت آتی ہے / ریٹ لمٹس استعمال ہوتی ہیں
  - “سب کچھ” چلانے کے بجائے محدود سب سیٹس کو ترجیح دیں
  - لائیو رنز گمشدہ API کلیدیں لینے کے لیے `~/.profile` سورس کریں گے
  - Anthropic کلید روٹیشن: `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (یا `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) یا متعدد `ANTHROPIC_API_KEY*` متغیرات سیٹ کریں؛ ٹیسٹس ریٹ لمٹس پر ری ٹرائی کریں گے

## مجھے کون سی سوئٹ چلانی چاہیے؟

اس فیصلہ جاتی جدول کو استعمال کریں:

- لاجک/ٹیسٹس میں ترمیم: `pnpm test` چلائیں (اور اگر بہت تبدیلیاں ہوں تو `pnpm test:coverage`)
- گیٹ وے نیٹ ورکنگ / WS پروٹوکول / پیئرنگ میں تبدیلی: `pnpm test:e2e` شامل کریں
- “میرا بوٹ ڈاؤن ہے” / فراہم کنندہ-خصوصی ناکامیاں / ٹول کالنگ کی ڈیبگنگ: محدود `pnpm test:live` چلائیں

## لائیو: ماڈل اسموک (پروفائل کلیدیں)

لائیو ٹیسٹس دو تہوں میں تقسیم ہیں تاکہ ناکامیوں کو الگ کیا جا سکے:

- “Direct model” بتاتا ہے کہ فراہم کنندہ/ماڈل دی گئی کلید کے ساتھ جواب دے سکتا ہے یا نہیں۔
- “Gateway smoke” بتاتا ہے کہ مکمل گیٹ وے+ایجنٹ پائپ لائن اس ماڈل کے لیے کام کرتی ہے (سیشنز، ہسٹری، ٹولز، sandbox پالیسی وغیرہ)۔

### تہہ 1: Direct model completion (بغیر گیٹ وے)

- ٹیسٹ: `src/agents/models.profiles.live.test.ts`
- مقصد:
  - دریافت شدہ ماڈلز کی فہرست بنانا
  - آپ کے پاس اسناد والے ماڈلز منتخب کرنے کے لیے `getApiKeyForModel` استعمال کرنا
  - ہر ماڈل پر ایک چھوٹا completion چلانا (اور جہاں ضرورت ہو ہدفی ریگریشنز)
- فعال کرنے کا طریقہ:
  - `pnpm test:live` (یا اگر Vitest براہِ راست چلائیں تو `OPENCLAW_LIVE_TEST=1`)
- اس سوئٹ کو واقعی چلانے کے لیے `OPENCLAW_LIVE_MODELS=modern` (یا جدید کے لیے عرف `all`) سیٹ کریں؛ ورنہ یہ اسکیپ ہو جاتا ہے تاکہ `pnpm test:live` گیٹ وے اسموک پر مرکوز رہے
- ماڈلز منتخب کرنے کا طریقہ:
  - جدید allowlist چلانے کے لیے `OPENCLAW_LIVE_MODELS=modern` (Opus/Sonnet/Haiku 4.5، GPT-5.x + Codex، Gemini 3، GLM 4.7، MiniMax M2.1، Grok 4)
  - جدید allowlist کے لیے عرف: `OPENCLAW_LIVE_MODELS=all`
  - یا `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (کاما allowlist)
- فراہم کنندگان منتخب کرنے کا طریقہ:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (کاما allowlist)
- کلیدیں کہاں سے آتی ہیں:
  - بطورِ طے شدہ: پروفائل اسٹور اور env فال بیکس
  - صرف **پروفائل اسٹور** نافذ کرنے کے لیے `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` سیٹ کریں
- یہ کیوں موجود ہے:
  - “فراہم کنندہ API ٹوٹا ہے / کلید غلط ہے” کو “گیٹ وے ایجنٹ پائپ لائن ٹوٹی ہے” سے الگ کرتا ہے
  - چھوٹی، الگ تھلگ ریگریشنز رکھتا ہے (مثال: OpenAI Responses/Codex Responses کی reasoning replay + tool-call فلو)

### تہہ 2: Gateway + dev agent smoke (جو “@openclaw” حقیقت میں کرتا ہے)

- ٹیسٹ: `src/gateway/gateway-models.profiles.live.test.ts`
- مقصد:
  - اِن-پروسیس گیٹ وے اسپن اپ کرنا
  - `agent:dev:*` سیشن بنانا/پیچ کرنا (ہر رن میں ماڈل اوور رائیڈ)
  - کلیدوں والے ماڈلز پر تکرار کر کے تصدیق:
    - “بامعنی” جواب (بغیر ٹولز)
    - حقیقی ٹول انووکییشن کام کرے (read پروب)
    - اختیاری اضافی ٹول پروبز (exec+read پروب)
    - OpenAI ریگریشن راستے (صرف tool-call → follow-up) درست رہیں
- پروب کی تفصیلات (تاکہ ناکامیوں کی فوری وضاحت ہو سکے):
  - `read` پروب: ٹیسٹ ورک اسپیس میں nonce فائل لکھتا ہے اور ایجنٹ سے اسے `read` کرنے اور nonce واپس echo کرنے کو کہتا ہے۔
  - `exec+read` پروب: ٹیسٹ ایجنٹ سے nonce کو temp فائل میں `exec`-write کرنے، پھر اسے `read` کرنے کو کہتا ہے۔
  - امیج پروب: ٹیسٹ ایک جنریٹڈ PNG (بلی + رینڈمائزڈ کوڈ) منسلک کرتا ہے اور ماڈل سے `cat <CODE>` واپس کرنے کی توقع رکھتا ہے۔
  - نفاذ حوالہ: `src/gateway/gateway-models.profiles.live.test.ts` اور `src/gateway/live-image-probe.ts`۔
- فعال کرنے کا طریقہ:
  - `pnpm test:live` (یا اگر Vitest براہِ راست چلائیں تو `OPENCLAW_LIVE_TEST=1`)
- ماڈلز منتخب کرنے کا طریقہ:
  - ڈیفالٹ: جدید allowlist (Opus/Sonnet/Haiku 4.5، GPT-5.x + Codex، Gemini 3، GLM 4.7، MiniMax M2.1، Grok 4)
  - جدید allowlist کے لیے عرف: `OPENCLAW_LIVE_GATEWAY_MODELS=all`
  - یا محدود کرنے کے لیے `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (یا کاما لسٹ)
- فراہم کنندگان منتخب کرنے کا طریقہ (“OpenRouter سب کچھ” سے بچیں):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (کاما allowlist)
- ٹول + امیج پروبز اس لائیو ٹیسٹ میں ہمیشہ آن ہوتے ہیں:
  - `read` پروب + `exec+read` پروب (ٹول اسٹریس)
  - امیج پروب تب چلتا ہے جب ماڈل امیج اِن پٹ سپورٹ ظاہر کرے
  - فلو (اعلیٰ سطح):
    - ٹیسٹ “CAT” + رینڈم کوڈ کے ساتھ ایک ننھا PNG بناتا ہے (`src/gateway/live-image-probe.ts`)
    - اسے `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]` کے ذریعے بھیجتا ہے
    - گیٹ وے اٹیچمنٹس کو `images[]` میں پارس کرتا ہے (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - ایمبیڈڈ ایجنٹ ماڈل کو ملٹی موڈل یوزر میسج فارورڈ کرتا ہے
    - تصدیق: جواب میں `cat` + کوڈ شامل ہو (OCR برداشت: معمولی غلطیاں قابلِ قبول)

مشورہ: اپنی مشین پر کیا ٹیسٹ ہو سکتے ہیں (اور عین `provider/model` IDs) دیکھنے کے لیے چلائیں:

```bash
openclaw models list
openclaw models list --json
```

## لائیو: Anthropic setup-token اسموک

- ٹیسٹ: `src/agents/anthropic.setup-token.live.test.ts`
- مقصد: Claude Code CLI setup-token (یا پیسٹ کیا ہوا setup-token پروفائل) کے ذریعے Anthropic پرامپٹ مکمل ہونا تصدیق کرنا۔
- فعال کریں:
  - `pnpm test:live` (یا اگر Vitest براہِ راست چلائیں تو `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- ٹوکن ذرائع (ایک منتخب کریں):
  - پروفائل: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - خام ٹوکن: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- ماڈل اوور رائیڈ (اختیاری):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

سیٹ اپ مثال:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## لائیو: CLI بیک اینڈ اسموک (Claude Code CLI یا دیگر لوکل CLIs)

- ٹیسٹ: `src/gateway/gateway-cli-backend.live.test.ts`
- مقصد: ڈیفالٹ کنفیگ کو چھیڑے بغیر لوکل CLI بیک اینڈ استعمال کرتے ہوئے Gateway + ایجنٹ پائپ لائن کی توثیق۔
- فعال کریں:
  - `pnpm test:live` (یا اگر Vitest براہِ راست چلائیں تو `OPENCLAW_LIVE_TEST=1`)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- ڈیفالٹس:
  - ماڈل: `claude-cli/claude-sonnet-4-5`
  - کمانڈ: `claude`
  - آرگز: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- اوور رائیڈز (اختیاری):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - حقیقی امیج اٹیچمنٹ بھیجنے کے لیے `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` (راستے پرامپٹ میں انجیکٹ ہوتے ہیں)
  - امیج فائل راستے CLI آرگز کے طور پر پاس کرنے کے لیے `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` بجائے پرامپٹ انجیکشن کے
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (یا `"list"`) تاکہ یہ کنٹرول ہو کہ جب `IMAGE_ARG` سیٹ ہو تو امیج آرگز کیسے پاس ہوں
  - دوسرا ٹرن بھیجنے اور ریزیوم فلو کی توثیق کے لیے `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1`
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` تاکہ Claude Code CLI MCP کنفیگ فعال رہے (ڈیفالٹ MCP کنفیگ کو عارضی خالی فائل کے ساتھ غیر فعال کرتا ہے)

مثال:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### سفارش کردہ لائیو ترکیبیں

محدود، واضح allowlists سب سے تیز اور کم غیر مستحکم ہوتی ہیں:

- واحد ماڈل، direct (بغیر گیٹ وے):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- واحد ماڈل، گیٹ وے اسموک:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- متعدد فراہم کنندگان میں ٹول کالنگ:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google فوکس (Gemini API کلید + Antigravity):
  - Gemini (API کلید): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

نوٹس:

- `google/...` Gemini API (API کلید) استعمال کرتا ہے۔
- `google-antigravity/...` Antigravity OAuth برج (Cloud Code Assist طرز کا ایجنٹ اینڈ پوائنٹ) استعمال کرتا ہے۔
- `google-gemini-cli/...` آپ کی مشین پر لوکل Gemini CLI استعمال کرتا ہے (الگ تصدیق + ٹولنگ کی نزاکتیں)۔
- Gemini API بمقابلہ Gemini CLI:
  - API: OpenClaw Google کی ہوسٹڈ Gemini API کو HTTP پر کال کرتا ہے (API کلید / پروفائل تصدیق)؛ یہی وہ ہے جسے زیادہ تر صارفین “Gemini” کہتے ہیں۔
  - CLI: OpenClaw لوکل `gemini` بائنری کو شیل آؤٹ کرتا ہے؛ اس کی اپنی تصدیق ہوتی ہے اور رویّہ مختلف ہو سکتا ہے (اسٹریمنگ/ٹول سپورٹ/ورژن فرق)۔

## لائیو: ماڈل میٹرکس (ہم کیا کور کرتے ہیں)

کوئی مقررہ “CI ماڈل لسٹ” نہیں (لائیو آپٹ-اِن ہے)، مگر یہ **سفارش کردہ** ماڈلز ہیں جنہیں کلیدوں کے ساتھ ڈیولپر مشین پر باقاعدگی سے کور کرنا چاہیے۔

### جدید اسموک سیٹ (ٹول کالنگ + امیج)

یہ “عام ماڈلز” رن ہے جس کے کام کرنے کی ہم توقع رکھتے ہیں:

- OpenAI (غیر Codex): `openai/gpt-5.2` (اختیاری: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (اختیاری: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (یا `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` اور `google/gemini-3-flash-preview` (پرانے Gemini 2.x ماڈلز سے پرہیز کریں)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` اور `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

ٹولز + امیج کے ساتھ گیٹ وے اسموک چلائیں:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### بیس لائن: ٹول کالنگ (Read + اختیاری Exec)

ہر فراہم کنندہ فیملی سے کم از کم ایک منتخب کریں:

- OpenAI: `openai/gpt-5.2` (یا `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (یا `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (یا `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

اختیاری اضافی کوریج (اچھا ہے مگر لازمی نہیں):

- xAI: `xai/grok-4` (یا تازہ ترین دستیاب)
- Mistral: `mistral/`… 31. (وہ ایک “tools” قابل ماڈل منتخب کریں جو آپ نے فعال کیا ہوا ہو)
- 32. Cerebras: `cerebras/`… (اگر آپ کو رسائی حاصل ہو)
- LM Studio: `lmstudio/`… (لوکل؛ ٹول کالنگ API موڈ پر منحصر ہے)

### وژن: امیج بھیجنا (اٹیچمنٹ → ملٹی موڈل پیغام)

33. `OPENCLAW_LIVE_GATEWAY_MODELS` میں کم از کم ایک image-capable ماڈل شامل کریں (Claude/Gemini/OpenAI vision-capable variants وغیرہ)۔ تاکہ امیج پروب کو آزمایا جا سکے۔

### ایگریگیٹرز / متبادل گیٹ ویز

اگر کلیدیں فعال ہوں تو ہم ان کے ذریعے بھی ٹیسٹنگ سپورٹ کرتے ہیں:

- OpenRouter: `openrouter/...` (سینکڑوں ماڈلز؛ ٹول+امیج قابل امیدوار ڈھونڈنے کے لیے `openclaw models scan` استعمال کریں)
- OpenCode Zen: `opencode/...` (تصدیق بذریعہ `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

مزید فراہم کنندگان جنہیں لائیو میٹرکس میں شامل کیا جا سکتا ہے (اگر اسناد/کنفیگ ہو):

- Built-in: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- بذریعہ `models.providers` (کسٹم اینڈ پوائنٹس): `minimax` (کلاؤڈ/API)، نیز کوئی بھی OpenAI/Anthropic-مطابقت رکھنے والا پراکسی (LM Studio، vLLM، LiteLLM وغیرہ)

ٹِپ: ڈاکس میں “تمام ماڈلز” کو ہارڈکوڈ کرنے کی کوشش نہ کریں۔ مستند فہرست وہی ہے جو `discoverModels(...)` آپ کی مشین پر واپس کرتا ہے + جو بھی keys دستیاب ہوں۔

## اسناد (کبھی کمٹ نہ کریں)

34. لائیو ٹیسٹس اسی طرح اسناد (credentials) دریافت کرتے ہیں جیسے CLI کرتا ہے۔ عملی مضمرات:

- اگر CLI کام کرتا ہے تو لائیو ٹیسٹس کو وہی کلیدیں ملنی چاہئیں۔

- اگر لائیو ٹیسٹ “no creds” کہے تو اسی طرح ڈیبگ کریں جیسے `openclaw models list` / ماڈل سلیکشن کو کرتے ہیں۔

- پروفائل اسٹور: `~/.openclaw/credentials/` (ترجیحی؛ ٹیسٹس میں “profile keys” سے مراد یہی ہے)

- کنفیگ: `~/.openclaw/openclaw.json` (یا `OPENCLAW_CONFIG_PATH`)

اگر آپ env کلیدوں پر انحصار کرنا چاہتے ہیں (مثلاً آپ کے `~/.profile` میں ایکسپورٹ ہوں)، تو `source ~/.profile` کے بعد لوکل ٹیسٹس چلائیں، یا نیچے دیے گئے Docker رَنرز استعمال کریں (وہ `~/.profile` کو کنٹینر میں ماؤنٹ کر سکتے ہیں)۔

## Deepgram لائیو (آڈیو ٹرانسکرپشن)

- ٹیسٹ: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Enable: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker رَنرز (اختیاری “Linux میں کام کرتا ہے” چیکس)

یہ repo Docker امیج کے اندر `pnpm test:live` چلاتے ہیں، آپ کی لوکل کنفیگ ڈائریکٹری اور ورک اسپیس ماؤنٹ کرتے ہوئے (اور اگر ماؤنٹ ہو تو `~/.profile` سورس کرتے ہوئے):

- Direct models: `pnpm test:docker:live-models` (اسکرپٹ: `scripts/test-live-models-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (اسکرپٹ: `scripts/test-live-gateway-models-docker.sh`)
- آن بورڈنگ وزارڈ (TTY، مکمل اسکیفولڈنگ): `pnpm test:docker:onboard` (اسکرپٹ: `scripts/e2e/onboard-docker.sh`)
- گیٹ وے نیٹ ورکنگ (دو کنٹینرز، WS تصدیق + صحت): `pnpm test:docker:gateway-network` (اسکرپٹ: `scripts/e2e/gateway-network-docker.sh`)
- پلگ اِنز (کسٹم ایکسٹینشن لوڈ + رجسٹری اسموک): `pnpm test:docker:plugins` (اسکرپٹ: `scripts/e2e/plugins-docker.sh`)

مفید env متغیرات:

- `OPENCLAW_CONFIG_DIR=...` (ڈیفالٹ: `~/.openclaw`) ماؤنٹ ہوتا ہے `/home/node/.openclaw` پر
- `OPENCLAW_WORKSPACE_DIR=...` (ڈیفالٹ: `~/.openclaw/workspace`) ماؤنٹ ہوتا ہے `/home/node/.openclaw/workspace` پر
- `OPENCLAW_PROFILE_FILE=...` (ڈیفالٹ: `~/.profile`) ماؤنٹ ہوتا ہے `/home/node/.profile` پر اور ٹیسٹس چلانے سے پہلے سورس کیا جاتا ہے
- رن کو محدود کرنے کے لیے `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...`
- اس بات کو یقینی بنانے کے لیے `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` کہ اسناد پروفائل اسٹور سے آئیں (env سے نہیں)

## دستاویزات کی صحت

ڈاک ایڈیٹس کے بعد ڈاک چیکس چلائیں: `pnpm docs:list`۔

## آف لائن ریگریشن (CI-محفوظ)

یہ حقیقی فراہم کنندگان کے بغیر “حقیقی پائپ لائن” ریگریشنز ہیں:

- گیٹ وے ٹول کالنگ (mock OpenAI، حقیقی گیٹ وے + ایجنٹ لوپ): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- گیٹ وے وزارڈ (WS `wizard.start`/`wizard.next`, کنفیگ لکھتا ہے + تصدیق نافذ): `src/gateway/gateway.wizard.e2e.test.ts`

## ایجنٹ قابلِ اعتمادیت ایوالز (Skills)

ہمارے پاس پہلے ہی چند CI-محفوظ ٹیسٹس ہیں جو “ایجنٹ قابلِ اعتمادیت ایوالز” جیسے برتاؤ کرتے ہیں:

- حقیقی گیٹ وے + ایجنٹ لوپ کے ذریعے mock ٹول کالنگ (`src/gateway/gateway.tool-calling.mock-openai.test.ts`)۔
- اینڈ-ٹو-اینڈ وزارڈ فلو جو سیشن وائرنگ اور کنفیگ اثرات کی توثیق کرتے ہیں (`src/gateway/gateway.wizard.e2e.test.ts`)۔

Skills کے لیے جو ابھی کمی ہے (دیکھیں [Skills](/tools/skills)):

- **Decisioning:** جب پرامپٹ میں Skills درج ہوں، کیا ایجنٹ درست Skill منتخب کرتا ہے (یا غیر متعلقہ سے پرہیز کرتا ہے)؟
- **Compliance:** کیا ایجنٹ استعمال سے پہلے `SKILL.md` پڑھتا ہے اور مطلوبہ مراحل/آرگز پر عمل کرتا ہے؟
- **Workflow contracts:** ملٹی-ٹرن منظرنامے جو ٹول آرڈر، سیشن ہسٹری کی منتقلی، اور sandbox حدود کی تصدیق کریں۔

مستقبل کی ایوالز کو پہلے متعین رہنا چاہیے:

- ایک منظرنامہ رَنر جو mock فراہم کنندگان استعمال کر کے ٹول کالز + ترتیب، Skill فائل ریڈز، اور سیشن وائرنگ کی تصدیق کرے۔
- Skill-مرکوز منظرناموں کا ایک چھوٹا سیٹ (استعمال بمقابلہ پرہیز، گیٹنگ، پرامپٹ انجیکشن)۔
- اختیاری لائیو ایوالز (آپٹ-اِن، env-گیٹڈ) صرف اس کے بعد جب CI-محفوظ سوئٹ موجود ہو۔

## ریگریشنز شامل کرنا (رہنمائی)

جب آپ لائیو میں دریافت شدہ کسی فراہم کنندہ/ماڈل مسئلے کو ٹھیک کریں:

- ممکن ہو تو CI-محفوظ ریگریشن شامل کریں (mock/stub فراہم کنندہ، یا عین request-shape تبدیلی کی گرفت)
- اگر یہ فطری طور پر صرف لائیو ہے (ریٹ لمٹس، تصدیقی پالیسیز)، تو لائیو ٹیسٹ کو محدود رکھیں اور env متغیرات کے ذریعے آپٹ-اِن بنائیں
- اس سب سے چھوٹی تہہ کو ہدف بنائیں جو بگ پکڑ لے:
  - فراہم کنندہ request conversion/replay بگ → direct models ٹیسٹ
  - گیٹ وے سیشن/ہسٹری/ٹول پائپ لائن بگ → گیٹ وے لائیو اسموک یا CI-محفوظ گیٹ وے mock ٹیسٹ
