---
summary: "یہ آڈٹ کریں کہ کیا چیز پیسہ خرچ کر سکتی ہے، کون سی کلیدیں استعمال ہو رہی ہیں، اور استعمال کو کیسے دیکھا جائے"
read_when:
  - آپ یہ سمجھنا چاہتے ہیں کہ کون سی خصوصیات ادائیگی شدہ APIs کو کال کر سکتی ہیں
  - آپ کو کلیدوں، اخراجات، اور استعمال کی مرئیت کا آڈٹ درکار ہے
  - آپ /status یا /usage کی لاگت رپورٹنگ کی وضاحت کر رہے ہیں
title: "API استعمال اور اخراجات"
---

# API استعمال اور اخراجات

یہ دستاویز **وہ خصوصیات** درج کرتی ہے جو API کیز کو استعمال کر سکتی ہیں اور جہاں ان کے اخراجات ظاہر ہوتے ہیں۔ یہ توجہ دیتی ہے
OpenClaw کی اُن خصوصیات پر جو پرووائیڈر کے استعمال یا بامعاوضہ API کالز پیدا کر سکتی ہیں۔

## اخراجات کہاں ظاہر ہوتے ہیں (چیٹ + CLI)

**فی سیشن لاگت کا اسنیپ شاٹ**

- `/status` موجودہ سیشن ماڈل، سیاق کے استعمال، اور آخری جواب کے ٹوکنز دکھاتا ہے۔
- اگر ماڈل **API-key auth** استعمال کرتا ہے، تو `/status` آخری جواب کے لیے **تخمینی لاگت** بھی دکھاتا ہے۔

**فی پیغام لاگت فوٹر**

- `/usage full` ہر جواب کے ساتھ استعمال کا فوٹر شامل کرتا ہے، جس میں **تخمینی لاگت** شامل ہوتی ہے (صرف API-key)۔
- `/usage tokens` صرف ٹوکنز دکھاتا ہے؛ OAuth فلو میں ڈالر لاگت چھپا دی جاتی ہے۔

**CLI استعمال ونڈوز (فراہم کنندہ کوٹاز)**

- `openclaw status --usage` اور `openclaw channels list` فراہم کنندہ کی **استعمال ونڈوز** دکھاتے ہیں
  (کوٹا اسنیپ شاٹس، فی پیغام لاگت نہیں)۔

تفصیلات اور مثالوں کے لیے [Token use & costs](/reference/token-use) دیکھیں۔

## کلیدیں کیسے دریافت کی جاتی ہیں

OpenClaw اسناد یہاں سے حاصل کر سکتا ہے:

- **Auth profiles** (ہر ایجنٹ کے لیے، `auth-profiles.json` میں محفوظ)۔
- **ماحولیاتی متغیرات** (مثلاً `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`)۔
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`)۔
- **اسکلز** (`skills.entries.<name>.apiKey`) جو اسکل پروسیس کے env میں کیز ایکسپورٹ کر سکتی ہیں۔

## وہ خصوصیات جو کلیدیں خرچ کر سکتی ہیں

### 1. بنیادی ماڈل کے جوابات (چیٹ + اوزار)

Every reply or tool call uses the **current model provider** (OpenAI, Anthropic, etc). This is the
primary source of usage and cost.

قیمتوں کی کنفیگ کے لیے [Models](/providers/models) اور ڈسپلے کے لیے [Token use & costs](/reference/token-use) دیکھیں۔

### 2. میڈیا کی سمجھ (آڈیو/تصویر/ویڈیو)

Inbound media can be summarized/transcribed before the reply runs. This uses model/provider APIs.

- آڈیو: OpenAI / Groq / Deepgram (اب **کلیدیں موجود ہوں تو خودکار طور پر فعال**)۔
- تصویر: OpenAI / Anthropic / Google۔
- ویڈیو: Google۔

دیکھیں [Media understanding](/nodes/media-understanding)۔

### 3. میموری ایمبیڈنگز + معنوی تلاش

معنوی میموری تلاش **embedding APIs** استعمال کرتی ہے جب ریموٹ فراہم کنندگان کے لیے کنفیگر کی جائے:

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- اگر لوکل ایمبیڈنگز ناکام ہوں تو ریموٹ فراہم کنندہ پر اختیاری فال بیک

آپ `memorySearch.provider = "local"` کے ساتھ اسے لوکل رکھ سکتے ہیں (کوئی API استعمال نہیں)۔

دیکھیں [Memory](/concepts/memory)۔

### 4. ویب سرچ ٹول (Brave / Perplexity بذریعہ OpenRouter)

`web_search` API کلیدیں استعمال کرتا ہے اور استعمالی چارجز عائد ہو سکتے ہیں:

- **Brave Search API**: `BRAVE_API_KEY` یا `tools.web.search.apiKey`
- **Perplexity** (بذریعہ OpenRouter): `PERPLEXITY_API_KEY` یا `OPENROUTER_API_KEY`

**Brave فری ٹئیر (فیاض):**

- **2,000 درخواستیں/ماہ**
- **1 درخواست/سیکنڈ**
- **کریڈٹ کارڈ درکار** برائے تصدیق (جب تک آپ اپ گریڈ نہ کریں کوئی چارج نہیں)

دیکھیں [Web tools](/tools/web)۔

### 5. ویب فیچ ٹول (Firecrawl)

`web_fetch` اس وقت **Firecrawl** کو کال کر سکتا ہے جب API کلید موجود ہو:

- `FIRECRAWL_API_KEY` یا `tools.web.fetch.firecrawl.apiKey`

اگر Firecrawl کنفیگر نہ ہو، تو ٹول براہِ راست فیچ + readability پر فال بیک کرتا ہے (کوئی ادائیگی شدہ API نہیں)۔

دیکھیں [Web tools](/tools/web)۔

### 6. فراہم کنندہ استعمال اسنیپ شاٹس (اسٹیٹس/ہیلتھ)

Some status commands call **provider usage endpoints** to display quota windows or auth health.
These are typically low-volume calls but still hit provider APIs:

- `openclaw status --usage`
- `openclaw models status --json`

دیکھیں [Models CLI](/cli/models)۔

### 7. کمپیکشن حفاظتی خلاصہ

کمپیکشن حفاظتی نظام **موجودہ ماڈل** استعمال کرتے ہوئے سیشن ہسٹری کا خلاصہ بنا سکتا ہے، جس کے چلنے پر
فراہم کنندہ APIs کال ہوتے ہیں۔

دیکھیں [Session management + compaction](/reference/session-management-compaction)۔

### 8. ماڈل اسکین / پروب

`openclaw models scan` OpenRouter ماڈلز کو پروب کر سکتا ہے اور جب
پروبنگ فعال ہو تو `OPENROUTER_API_KEY` استعمال کرتا ہے۔

دیکھیں [Models CLI](/cli/models)۔

### 9. ٹاک (تقریر)

Talk موڈ کنفیگر ہونے پر **ElevenLabs** کو کال کر سکتا ہے:

- `ELEVENLABS_API_KEY` یا `talk.apiKey`

دیکھیں [Talk mode](/nodes/talk)۔

### 10. Skills (تیسرے فریق APIs)

Skills can store `apiKey` in `skills.entries.<name>.apiKey`. If a skill uses that key for external
APIs, it can incur costs according to the skill’s provider.

دیکھیں [Skills](/tools/skills)۔
