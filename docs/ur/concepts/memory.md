---
summary: "OpenClaw میموری کیسے کام کرتی ہے (ورک اسپیس فائلیں + خودکار میموری فلش)"
read_when:
  - آپ کو میموری فائل لےآؤٹ اور ورک فلو درکار ہو
  - آپ خودکار پری-کمپیکشن میموری فلش کو ٹیون کرنا چاہتے ہوں
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:09Z
---

# میموری

OpenClaw میموری **ایجنٹ ورک اسپیس میں سادہ Markdown** ہے۔ فائلیں
حقیقی ماخذ ہیں؛ ماڈل صرف وہی “یاد” رکھتا ہے جو ڈسک پر لکھا جاتا ہے۔

میموری سرچ کے اوزار فعال میموری پلگ اِن فراہم کرتا ہے (ڈیفالٹ:
`memory-core`)۔ میموری پلگ اِنز کو `plugins.slots.memory = "none"` کے ساتھ غیر فعال کریں۔

## میموری فائلیں (Markdown)

ڈیفالٹ ورک اسپیس لےآؤٹ دو میموری لیئرز استعمال کرتا ہے:

- `memory/YYYY-MM-DD.md`
  - روزانہ لاگ (صرف اضافہ ہوتا ہے)۔
  - سیشن شروع پر آج + کل کی قراءت۔
- `MEMORY.md` (اختیاری)
  - ترتیب دی گئی طویل مدتی میموری۔
  - **صرف مرکزی، نجی سیشن میں لوڈ کریں** (گروپ سیاق میں کبھی نہیں)۔

یہ فائلیں ورک اسپیس کے تحت ہوتی ہیں (`agents.defaults.workspace`, ڈیفالٹ
`~/.openclaw/workspace`)۔ مکمل لےآؤٹ کے لیے [Agent workspace](/concepts/agent-workspace) دیکھیں۔

## میموری کب لکھیں

- فیصلے، ترجیحات، اور پائیدار حقائق `MEMORY.md` میں جائیں۔
- روزمرہ نوٹس اور جاری سیاق `memory/YYYY-MM-DD.md` میں جائیں۔
- اگر کوئی کہے “اسے یاد رکھو”، تو لکھ دیں (RAM میں نہ رکھیں)۔
- یہ حصہ اب بھی ارتقا پذیر ہے۔ ماڈل کو میموری محفوظ کرنے کی یاد دہانی مددگار ہوتی ہے؛ وہ جان لے گا کیا کرنا ہے۔
- اگر آپ چاہتے ہیں کہ کوئی چیز قائم رہے، **بوٹ سے کہیں کہ اسے میموری میں لکھ دے**۔

## خودکار میموری فلش (پری-کمپیکشن پِنگ)

جب کوئی سیشن **آٹو-کمپیکشن کے قریب** ہوتا ہے، OpenClaw ایک **خاموش،
ایجنٹک ٹرن** چلاتا ہے جو ماڈل کو سیاق کے کمپیکٹ ہونے **سے پہلے** پائیدار میموری لکھنے کی یاد دہانی کراتا ہے۔ ڈیفالٹ پرامپٹس واضح طور پر کہتے ہیں کہ ماڈل _جواب دے سکتا ہے_، مگر عموماً `NO_REPLY` درست ردِعمل ہوتا ہے تاکہ صارف کو یہ ٹرن نظر نہ آئے۔

یہ `agents.defaults.compaction.memoryFlush` کے ذریعے کنٹرول ہوتا ہے:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

تفصیلات:

- **سوفٹ تھریش ہولڈ**: فلش اس وقت ٹرگر ہوتی ہے جب سیشن ٹوکن تخمینہ
  `contextWindow - reserveTokensFloor - softThresholdTokens` سے تجاوز کرے۔
- **بطورِ طے شدہ خاموش**: پرامپٹس میں `NO_REPLY` شامل ہوتا ہے تاکہ کچھ ڈیلیور نہ ہو۔
- **دو پرامپٹس**: ایک صارف پرامپٹ اور ایک سسٹم پرامپٹ یاد دہانی شامل کرتے ہیں۔
- **ہر کمپیکشن سائیکل میں ایک فلش** (`sessions.json` میں ٹریک ہوتی ہے)۔
- **ورک اسپیس قابلِ تحریر ہونا لازم**: اگر سیشن sandboxed حالت میں
  `workspaceAccess: "ro"` یا `"none"` کے ساتھ چل رہا ہو تو فلش چھوڑ دی جاتی ہے۔

کمپیکشن کے مکمل لائف سائیکل کے لیے دیکھیں
[Session management + compaction](/reference/session-management-compaction)۔

## ویکٹر میموری سرچ

OpenClaw `MEMORY.md` اور `memory/*.md` پر ایک چھوٹا ویکٹر انڈیکس بنا سکتا ہے تاکہ
سیمنٹک کوئریز مختلف الفاظ ہونے کے باوجود متعلقہ نوٹس تلاش کر سکیں۔

ڈیفالٹس:

- بطورِ طے شدہ فعال۔
- میموری فائلوں میں تبدیلیوں کو دیکھتا ہے (ڈی باؤنسڈ)۔
- بطورِ طے شدہ ریموٹ ایمبیڈنگز استعمال کرتا ہے۔ اگر `memorySearch.provider` سیٹ نہ ہو تو OpenClaw خودکار طور پر منتخب کرتا ہے:
  1. `local` اگر `memorySearch.local.modelPath` کنفیگر ہو اور فائل موجود ہو۔
  2. `openai` اگر OpenAI کلید حل ہو سکے۔
  3. `gemini` اگر Gemini کلید حل ہو سکے۔
  4. `voyage` اگر Voyage کلید حل ہو سکے۔
  5. بصورتِ دیگر کنفیگریشن تک میموری سرچ غیر فعال رہتی ہے۔
- لوکل موڈ node-llama-cpp استعمال کرتا ہے اور `pnpm approve-builds` درکار ہو سکتا ہے۔
- SQLite کے اندر ویکٹر سرچ تیز کرنے کے لیے sqlite-vec (جب دستیاب ہو) استعمال کرتا ہے۔

ریموٹ ایمبیڈنگز کے لیے ایمبیڈنگ فراہم کنندہ کی API کلید **لازم** ہے۔ OpenClaw
کلیدیں auth پروفائلز، `models.providers.*.apiKey`، یا ماحولیاتی
متغیرات سے حل کرتا ہے۔ Codex OAuth صرف چیٹ/کمپلیشنز کو کور کرتا ہے اور میموری سرچ کے لیے ایمبیڈنگز **پورا نہیں کرتا**۔ Gemini کے لیے `GEMINI_API_KEY` یا
`models.providers.google.apiKey` استعمال کریں۔ Voyage کے لیے `VOYAGE_API_KEY` یا
`models.providers.voyage.apiKey` استعمال کریں۔ کسٹم OpenAI-مطابقتی اینڈپوائنٹ استعمال کرتے وقت،
`memorySearch.remote.apiKey` سیٹ کریں (اور اختیاری `memorySearch.remote.headers`)۔

### QMD بیک اینڈ (تجرباتی)

بلٹ اِن SQLite انڈیکسر کی جگہ
[QMD](https://github.com/tobi/qmd) استعمال کرنے کے لیے `memory.backend = "qmd"` سیٹ کریں: ایک لوکل-فرسٹ سرچ سائیڈکار جو
BM25 + ویکٹرز + ری رینکنگ کو یکجا کرتا ہے۔ Markdown حقیقی ماخذ رہتا ہے؛ OpenClaw
ریٹریول کے لیے QMD کو شیل آؤٹ کرتا ہے۔ اہم نکات:

**پیشگی تقاضے**

- بطورِ طے شدہ غیر فعال۔ فی کنفیگ آپٹ اِن کریں (`memory.backend = "qmd"`)۔
- QMD CLI الگ سے انسٹال کریں (`bun install -g https://github.com/tobi/qmd` یا
  ریلیز حاصل کریں) اور یقینی بنائیں کہ `qmd` بائنری گیٹ وے کے `PATH` پر موجود ہو۔
- QMD کو ایسی SQLite بلڈ درکار ہے جو ایکسٹینشنز کی اجازت دے (`brew install sqlite` برائے
  macOS)۔
- QMD مکمل طور پر لوکل Bun + `node-llama-cpp` کے ذریعے چلتا ہے اور پہلی بار استعمال پر HuggingFace سے GGUF
  ماڈلز خودکار طور پر ڈاؤن لوڈ کرتا ہے (الگ Ollama ڈیمَن درکار نہیں)۔
- گیٹ وے QMD کو خودمختار XDG ہوم میں
  `~/.openclaw/agents/<agentId>/qmd/` کے تحت چلاتا ہے، `XDG_CONFIG_HOME` اور
  `XDG_CACHE_HOME` سیٹ کر کے۔
- OS سپورٹ: macOS اور Linux Bun + SQLite انسٹال ہونے کے بعد فوراً کام کرتے ہیں۔ Windows کے لیے WSL2 بہترین ہے۔

**سائیڈکار کیسے چلتا ہے**

- گیٹ وے ایک خودمختار QMD ہوم
  `~/.openclaw/agents/<agentId>/qmd/` کے تحت لکھتا ہے (کنفیگ + کیش + sqlite DB)۔
- کلیکشنز `qmd collection add` کے ذریعے `memory.qmd.paths` سے بنائے جاتے ہیں
  (اور ڈیفالٹ ورک اسپیس میموری فائلیں)، پھر `qmd update` + `qmd embed` بوٹ پر اور ایک قابلِ کنفیگر وقفے پر چلتے ہیں (`memory.qmd.update.interval`,
  ڈیفالٹ 5 m)۔
- بوٹ ریفریش اب بطورِ طے شدہ بیک گراؤنڈ میں چلتا ہے تاکہ چیٹ اسٹارٹ اپ بلاک نہ ہو؛
  پچھلا بلاکنگ رویہ رکھنے کے لیے `memory.qmd.update.waitForBootSync = true` سیٹ کریں۔
- سرچز `qmd query --json` کے ذریعے چلتی ہیں۔ اگر QMD ناکام ہو یا بائنری غائب ہو،
  OpenClaw خودکار طور پر بلٹ اِن SQLite مینیجر پر واپس آ جاتا ہے تاکہ میموری ٹولز
  کام کرتے رہیں۔
- OpenClaw فی الحال QMD ایمبیڈ بیچ-سائز ٹیوننگ ایکسپوز نہیں کرتا؛ بیچ رویہ
  QMD خود کنٹرول کرتا ہے۔
- **پہلی سرچ سست ہو سکتی ہے**: QMD پہلی `qmd query` رن پر لوکل GGUF ماڈلز (ری رینکر/کوئری ایکسپینشن) ڈاؤن لوڈ کر سکتا ہے۔
  - OpenClaw QMD چلانے پر `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` خودکار طور پر سیٹ کرتا ہے۔
  - اگر آپ ماڈلز دستی طور پر پری-ڈاؤن لوڈ کرنا چاہتے ہیں (اور وہی انڈیکس وارم کریں جو OpenClaw استعمال کرتا ہے)،
    ایجنٹ کے XDG ڈائریکٹریز کے ساتھ ایک وقتی کوئری چلائیں۔

    OpenClaw کی QMD اسٹیٹ آپ کی **اسٹیٹ ڈائریکٹری** کے تحت ہوتی ہے (ڈیفالٹ `~/.openclaw`)۔
    وہی XDG متغیرات ایکسپورٹ کر کے `qmd` کو بالکل اسی انڈیکس کی طرف پوائنٹ کیا جا سکتا ہے جو OpenClaw استعمال کرتا ہے:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**کنفیگ سطح (`memory.qmd.*`)**

- `command` (ڈیفالٹ `qmd`): ایگزیکیوبل پاتھ اووررائیڈ کریں۔
- `includeDefaultMemory` (ڈیفالٹ `true`): `MEMORY.md` + `memory/**/*.md` کو خودکار انڈیکس کریں۔
- `paths[]`: اضافی ڈائریکٹریز/فائلیں شامل کریں (`path`, اختیاری `pattern`, اختیاری
  مستحکم `name`)۔
- `sessions`: سیشن JSONL انڈیکسنگ میں آپٹ اِن (`enabled`, `retentionDays`,
  `exportDir`)۔
- `update`: ریفریش کیڈینس اور مینٹیننس ایکزیکیوشن کنٹرول کرتا ہے:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`)۔
- `limits`: ریکال پے لوڈ محدود کریں (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`)۔
- `scope`: [`session.sendPolicy`](/gateway/configuration#session) جیسا ہی اسکیما۔
  ڈیفالٹ DM-only ہے (`deny` سب، `allow` براہِ راست چیٹس)؛
  گروپس/چینلز میں QMD ہِٹس دکھانے کے لیے اسے نرم کریں۔
- ورک اسپیس کے باہر سے آنے والے اسنیپٹس
  `qmd/<collection>/<relative-path>` کے طور پر `memory_search` نتائج میں دکھائی دیتے ہیں؛
  `memory_get` اس پریفکس کو سمجھتا ہے اور کنفیگرڈ QMD کلیکشن روٹ سے پڑھتا ہے۔
- جب `memory.qmd.sessions.enabled = true` ہو، OpenClaw صاف کی گئی سیشن
  ٹرانسکرپٹس (User/Assistant ٹرنز) کو
  `~/.openclaw/agents/<id>/qmd/sessions/` کے تحت ایک مخصوص QMD کلیکشن میں ایکسپورٹ کرتا ہے، تاکہ `memory_search` حالیہ
  گفتگوئیں بلٹ اِن SQLite انڈیکس کو چھوئے بغیر یاد کر سکے۔
- `memory_search` اسنیپٹس اب `Source: <path#line>` فوٹر شامل کرتے ہیں جب
  `memory.citations` `auto`/`on` ہو؛
  پاتھ میٹاڈیٹا اندرونی رکھنے کے لیے `memory.citations = "off"` سیٹ کریں
  (ایجنٹ کو پھر بھی `memory_get` کے لیے پاتھ ملتا ہے، مگر اسنیپٹ متن فوٹر چھوڑ دیتا ہے اور سسٹم پرامپٹ ایجنٹ کو اسے حوالہ دینے سے روکتا ہے)۔

**مثال**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**حوالہ جات اور فال بیک**

- `memory.citations` بیک اینڈ سے قطع نظر لاگو ہوتا ہے (`auto`/`on`/`off`)۔
- جب `qmd` چلتا ہے، ہم `status().backend = "qmd"` ٹیگ کرتے ہیں تاکہ تشخیصی معلومات دکھائیں کہ
  کون سا انجن نتائج فراہم کر رہا تھا۔ اگر QMD سب پروسیس بند ہو جائے یا JSON آؤٹ پٹ پارس نہ ہو سکے،
  سرچ مینیجر وارننگ لاگ کرتا ہے اور QMD کے بحال ہونے تک بلٹ اِن فراہم کنندہ
  (موجودہ Markdown ایمبیڈنگز) واپس کر دیتا ہے۔

### اضافی میموری راستے

اگر آپ ڈیفالٹ ورک اسپیس لےآؤٹ سے باہر Markdown فائلیں انڈیکس کرنا چاہتے ہیں تو
واضح راستے شامل کریں:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

نوٹس:

- راستے مطلق یا ورک اسپیس-نسبتی ہو سکتے ہیں۔
- ڈائریکٹریز کو `.md` فائلوں کے لیے ریکرسیولی اسکین کیا جاتا ہے۔
- صرف Markdown فائلیں انڈیکس ہوتی ہیں۔
- Symlinks (فائلیں یا ڈائریکٹریز) نظرانداز کیے جاتے ہیں۔

### Gemini ایمبیڈنگز (نیٹو)

Gemini ایمبیڈنگز API براہِ راست استعمال کرنے کے لیے فراہم کنندہ کو `gemini` پر سیٹ کریں:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

نوٹس:

- `remote.baseUrl` اختیاری ہے (ڈیفالٹ Gemini API بیس URL)۔
- `remote.headers` اضافی ہیڈرز شامل کرنے دیتا ہے اگر ضرورت ہو۔
- ڈیفالٹ ماڈل: `gemini-embedding-001`۔

اگر آپ **کسٹم OpenAI-مطابقتی اینڈپوائنٹ** (OpenRouter، vLLM، یا کوئی پروکسی) استعمال کرنا چاہتے ہیں،
تو OpenAI فراہم کنندہ کے ساتھ `remote` کنفیگریشن استعمال کر سکتے ہیں:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

اگر آپ API کلید سیٹ نہیں کرنا چاہتے تو `memorySearch.provider = "local"` استعمال کریں یا
`memorySearch.fallback = "none"` سیٹ کریں۔

فال بیکس:

- `memorySearch.fallback` `openai`, `gemini`, `local`, یا `none` ہو سکتا ہے۔
- فال بیک فراہم کنندہ صرف اس وقت استعمال ہوتا ہے جب بنیادی ایمبیڈنگ فراہم کنندہ ناکام ہو۔

بیچ انڈیکسنگ (OpenAI + Gemini):

- OpenAI اور Gemini ایمبیڈنگز کے لیے بطورِ طے شدہ فعال۔ غیر فعال کرنے کے لیے `agents.defaults.memorySearch.remote.batch.enabled = false` سیٹ کریں۔
- ڈیفالٹ رویہ بیچ مکمل ہونے کا انتظار کرتا ہے؛ ضرورت ہو تو `remote.batch.wait`, `remote.batch.pollIntervalMs`, اور `remote.batch.timeoutMinutes` ٹیون کریں۔
- متوازی طور پر جمع کرائے جانے والے بیچ جابز کی تعداد کنٹرول کرنے کے لیے `remote.batch.concurrency` سیٹ کریں (ڈیفالٹ: 2)۔
- بیچ موڈ اس وقت لاگو ہوتا ہے جب `memorySearch.provider = "openai"` یا `"gemini"` ہو اور متعلقہ API کلید استعمال کرتا ہے۔
- Gemini بیچ جابز async ایمبیڈنگز بیچ اینڈپوائنٹ استعمال کرتی ہیں اور Gemini Batch API کی دستیابی درکار ہوتی ہے۔

OpenAI بیچ کیوں تیز + سستا ہے:

- بڑے بیک فلز کے لیے، OpenAI عموماً سب سے تیز آپشن ہوتا ہے کیونکہ ہم ایک ہی بیچ جاب میں بہت سی ایمبیڈنگ درخواستیں جمع کرا سکتے ہیں اور OpenAI کو انہیں غیر ہم زمانی طور پر پروسیس کرنے دیتے ہیں۔
- OpenAI بیچ API ورک لوڈز کے لیے رعایتی قیمتیں پیش کرتا ہے، اس لیے بڑے انڈیکسنگ رنز عموماً انہی درخواستوں کو ہم زمانی طور پر بھیجنے سے سستے پڑتے ہیں۔
- تفصیلات کے لیے OpenAI Batch API دستاویزات اور قیمتیں دیکھیں:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

کنفیگ مثال:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

اوزار:

- `memory_search` — فائل + لائن رینجز کے ساتھ اسنیپٹس واپس کرتا ہے۔
- `memory_get` — پاتھ کے ذریعے میموری فائل کا مواد پڑھتا ہے۔

لوکل موڈ:

- `agents.defaults.memorySearch.provider = "local"` سیٹ کریں۔
- `agents.defaults.memorySearch.local.modelPath` فراہم کریں (GGUF یا `hf:` URI)۔
- اختیاری: ریموٹ فال بیک سے بچنے کے لیے `agents.defaults.memorySearch.fallback = "none"` سیٹ کریں۔

### میموری ٹولز کیسے کام کرتے ہیں

- `memory_search` `MEMORY.md` + `memory/**/*.md` سے Markdown حصّوں (~400 ٹوکن ہدف، 80-ٹوکن اوورلیپ) کی سیمنٹک سرچ کرتا ہے۔ یہ اسنیپٹ متن (تقریباً 700 حروف کی حد)، فائل پاتھ، لائن رینج، اسکور، فراہم کنندہ/ماڈل، اور یہ کہ ہم لوکل → ریموٹ ایمبیڈنگز پر فال بیک ہوئے یا نہیں، واپس کرتا ہے۔ مکمل فائل پے لوڈ واپس نہیں کیا جاتا۔
- `memory_get` کسی مخصوص میموری Markdown فائل (ورک اسپیس-نسبتی) کو پڑھتا ہے، اختیاری طور پر کسی ابتدائی لائن سے اور N لائنوں کے لیے۔ `MEMORY.md` / `memory/` سے باہر کے راستے مسترد کر دیے جاتے ہیں۔
- دونوں ٹولز صرف اس وقت فعال ہوتے ہیں جب ایجنٹ کے لیے `memorySearch.enabled` درست ثابت ہو۔

### کیا چیز انڈیکس ہوتی ہے (اور کب)

- فائل قسم: صرف Markdown (`MEMORY.md`, `memory/**/*.md`)۔
- انڈیکس اسٹوریج: فی ایجنٹ SQLite، مقام `~/.openclaw/memory/<agentId>.sqlite` (کنفیگ کے ذریعے `agents.defaults.memorySearch.store.path`؛ `{agentId}` ٹوکن سپورٹ)۔
- تازگی: `MEMORY.md` + `memory/` پر واچر انڈیکس کو ڈرٹی مارک کرتا ہے (ڈی باؤنس 1.5s)۔ سنک سیشن اسٹارٹ، سرچ، یا وقفے پر شیڈول ہوتی ہے اور غیر ہم زمانی چلتی ہے۔ سیشن ٹرانسکرپٹس بیک گراؤنڈ سنک ٹرگر کرنے کے لیے ڈیلٹا تھریش ہولڈز استعمال کرتے ہیں۔
- ری انڈیکس ٹرگرز: انڈیکس ایمبیڈنگ **فراہم کنندہ/ماڈل + اینڈپوائنٹ فنگرپرنٹ + چنکنگ پیرامیٹرز** محفوظ کرتا ہے۔ ان میں سے کوئی بدلے تو OpenClaw خودکار طور پر پورا اسٹور ری سیٹ کر کے ری انڈیکس کرتا ہے۔

### ہائبرڈ سرچ (BM25 + ویکٹر)

فعال ہونے پر، OpenClaw یکجا کرتا ہے:

- **ویکٹر مماثلت** (سیمنٹک میچ، الفاظ مختلف ہو سکتے ہیں)
- **BM25 کی ورڈ مطابقت** (عین ٹوکنز جیسے IDs، env vars، کوڈ سمبلز)

اگر آپ کے پلیٹ فارم پر فل ٹیکسٹ سرچ دستیاب نہ ہو تو OpenClaw ویکٹر-اونلی سرچ پر واپس آ جاتا ہے۔

#### ہائبرڈ کیوں؟

ویکٹر سرچ “یہ وہی معنی رکھتا ہے” میں بہترین ہے:

- “Mac Studio gateway host” بمقابلہ “the machine running the gateway”
- “debounce file updates” بمقابلہ “avoid indexing on every write”

لیکن عین، ہائی-سگنل ٹوکنز میں کمزور ہو سکتی ہے:

- IDs (`a828e60`, `b3b9895a…`)
- کوڈ سمبلز (`memorySearch.query.hybrid`)
- ایرر اسٹرنگز (“sqlite-vec unavailable”)

BM25 (فل ٹیکسٹ) اس کے برعکس ہے: عین ٹوکنز میں مضبوط، پیرا فریزز میں کمزور۔
ہائبرڈ سرچ عملی درمیانی راستہ ہے: **دونوں ریٹریول سگنلز استعمال کریں** تاکہ
“قدرتی زبان” اور “سوئی تنکے میں” دونوں قسم کی کوئریز کے لیے اچھے نتائج ملیں۔

#### نتائج کیسے ملاتے ہیں (موجودہ ڈیزائن)

عملی خاکہ:

1. دونوں اطراف سے امیدوار پول حاصل کریں:

- **ویکٹر**: کوسائن مماثلت کے لحاظ سے ٹاپ `maxResults * candidateMultiplier`۔
- **BM25**: FTS5 BM25 رینک کے لحاظ سے ٹاپ `maxResults * candidateMultiplier` (کم بہتر ہے)۔

2. BM25 رینک کو 0..1 جیسے اسکور میں تبدیل کریں:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. چنک آئی ڈی کے مطابق امیدواروں کو یونین کریں اور وزنی اسکور نکالیں:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

نوٹس:

- `vectorWeight` + `textWeight` کنفیگ ریزولوشن میں 1.0 پر نارملائز ہوتے ہیں، اس لیے وزن فیصد کی طرح برتاؤ کرتے ہیں۔
- اگر ایمبیڈنگز دستیاب نہ ہوں (یا فراہم کنندہ زیرو-ویکٹر لوٹائے)، ہم پھر بھی BM25 چلاتے ہیں اور کی ورڈ میچز واپس کرتے ہیں۔
- اگر FTS5 نہ بن سکے تو ہم ویکٹر-اونلی سرچ رکھتے ہیں (کوئی ہارڈ فیل نہیں)۔

یہ “IR تھیوری کے لحاظ سے کامل” نہیں، مگر سادہ، تیز، اور حقیقی نوٹس پر یادداشت/درستگی بہتر کرتا ہے۔
آگے چل کر عام اگلے قدم Reciprocal Rank Fusion (RRF) یا اسکور نارملائزیشن
(min/max یا z-score) ہو سکتے ہیں۔

کنفیگ:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### ایمبیڈنگ کیش

OpenClaw **چنک ایمبیڈنگز** کو SQLite میں کیش کر سکتا ہے تاکہ ری انڈیکسنگ اور بار بار اپ ڈیٹس
(خاص طور پر سیشن ٹرانسکرپٹس) غیر تبدیل شدہ متن کو دوبارہ ایمبیڈ نہ کریں۔

کنفیگ:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### سیشن میموری سرچ (تجرباتی)

آپ اختیاری طور پر **سیشن ٹرانسکرپٹس** انڈیکس کر کے انہیں `memory_search` کے ذریعے سامنے لا سکتے ہیں۔
یہ ایک تجرباتی فلیگ کے پیچھے ہے۔

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

نوٹس:

- سیشن انڈیکسنگ **آپٹ اِن** ہے (بطورِ طے شدہ بند)۔
- سیشن اپ ڈیٹس ڈی باؤنسڈ ہیں اور ڈیلٹا تھریش ہولڈز عبور کرنے پر **غیر ہم زمانی طور پر انڈیکس** ہوتی ہیں (بہترین کوشش)۔
- `memory_search` کبھی انڈیکسنگ پر بلاک نہیں کرتا؛ بیک گراؤنڈ سنک مکمل ہونے تک نتائج قدرے پرانے ہو سکتے ہیں۔
- نتائج میں اب بھی صرف اسنیپٹس شامل ہوتے ہیں؛ `memory_get` میموری فائلوں تک محدود رہتا ہے۔
- سیشن انڈیکسنگ فی ایجنٹ علیحدہ ہے (صرف اسی ایجنٹ کے سیشن لاگز انڈیکس ہوتے ہیں)۔
- سیشن لاگز ڈسک پر رہتے ہیں (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)۔ فائل سسٹم رسائی والا کوئی بھی عمل/صارف انہیں پڑھ سکتا ہے، اس لیے ڈسک رسائی کو اعتماد کی حد سمجھیں۔ زیادہ سخت علیحدگی کے لیے ایجنٹس کو الگ OS صارفین یا ہوسٹس کے تحت چلائیں۔

ڈیلٹا تھریش ہولڈز (ڈیفالٹس دکھائے گئے):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### SQLite ویکٹر ایکسیلیریشن (sqlite-vec)

جب sqlite-vec ایکسٹینشن دستیاب ہو، OpenClaw ایمبیڈنگز کو
SQLite ورچوئل ٹیبل (`vec0`) میں محفوظ کرتا ہے اور ویکٹر فاصلے کی کوئریز
ڈیٹا بیس میں انجام دیتا ہے۔ اس سے ہر ایمبیڈنگ کو JS میں لوڈ کیے بغیر سرچ تیز رہتی ہے۔

کنفیگریشن (اختیاری):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

نوٹس:

- `enabled` بطورِ طے شدہ true ہے؛ غیر فعال ہونے پر سرچ محفوظ شدہ ایمبیڈنگز پر اِن-پروسیس
  کوسائن مماثلت پر واپس آ جاتی ہے۔
- اگر sqlite-vec ایکسٹینشن غائب ہو یا لوڈ نہ ہو سکے تو OpenClaw
  ایرر لاگ کرتا ہے اور JS فال بیک کے ساتھ جاری رہتا ہے (کوئی ویکٹر ٹیبل نہیں)۔
- `extensionPath` بنڈلڈ sqlite-vec پاتھ اووررائیڈ کرتا ہے (کسٹم بلڈز
  یا غیر معیاری انسٹال لوکیشنز کے لیے مفید)۔

### لوکل ایمبیڈنگ خودکار ڈاؤن لوڈ

- ڈیفالٹ لوکل ایمبیڈنگ ماڈل: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 GB)۔
- جب `memorySearch.provider = "local"` ہو، `node-llama-cpp` `modelPath` حل کرتا ہے؛ اگر GGUF غائب ہو تو اسے **خودکار ڈاؤن لوڈ** کر کے کیش میں رکھتا ہے (یا `local.modelCacheDir` اگر سیٹ ہو)، پھر لوڈ کرتا ہے۔ ڈاؤن لوڈز ری ٹرائی پر دوبارہ شروع ہو جاتے ہیں۔
- نیٹو بلڈ تقاضا: `pnpm approve-builds` چلائیں، `node-llama-cpp` منتخب کریں، پھر `pnpm rebuild node-llama-cpp`۔
- فال بیک: اگر لوکل سیٹ اپ ناکام ہو اور `memorySearch.fallback = "openai"` ہو تو ہم خودکار طور پر ریموٹ ایمبیڈنگز پر سوئچ کرتے ہیں (`openai/text-embedding-3-small` جب تک اووررائیڈ نہ ہو) اور وجہ ریکارڈ کرتے ہیں۔

### کسٹم OpenAI-مطابقتی اینڈپوائنٹ مثال

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

نوٹس:

- `remote.*`، `models.providers.openai.*` پر فوقیت رکھتا ہے۔
- `remote.headers` OpenAI ہیڈرز کے ساتھ مرج ہوتا ہے؛ کلیدی تنازعات میں ریموٹ غالب رہتا ہے۔ OpenAI ڈیفالٹس استعمال کرنے کے لیے `remote.headers` چھوڑ دیں۔
