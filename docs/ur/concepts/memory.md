---
summary: "OpenClaw میموری کیسے کام کرتی ہے (ورک اسپیس فائلیں + خودکار میموری فلش)"
read_when:
  - آپ کو میموری فائل لےآؤٹ اور ورک فلو درکار ہو
  - آپ خودکار پری-کمپیکشن میموری فلش کو ٹیون کرنا چاہتے ہوں
---

# میموری

OpenClaw memory is **plain Markdown in the agent workspace**. The files are the
source of truth; the model only "remembers" what gets written to disk.

19. میموری سرچ ٹولز فعال میموری پلگ ان کے ذریعے فراہم کیے جاتے ہیں (ڈیفالٹ:
    `memory-core`)۔ Disable memory plugins with `plugins.slots.memory = "none"`.

## میموری فائلیں (Markdown)

ڈیفالٹ ورک اسپیس لےآؤٹ دو میموری لیئرز استعمال کرتا ہے:

- `memory/YYYY-MM-DD.md`
  - روزانہ لاگ (صرف اضافہ ہوتا ہے)۔
  - سیشن شروع پر آج + کل کی قراءت۔
- `MEMORY.md` (اختیاری)
  - ترتیب دی گئی طویل مدتی میموری۔
  - **صرف مرکزی، نجی سیشن میں لوڈ کریں** (گروپ سیاق میں کبھی نہیں)۔

These files live under the workspace (`agents.defaults.workspace`, default
`~/.openclaw/workspace`). See [Agent workspace](/concepts/agent-workspace) for the full layout.

## میموری کب لکھیں

- فیصلے، ترجیحات، اور پائیدار حقائق `MEMORY.md` میں جائیں۔
- روزمرہ نوٹس اور جاری سیاق `memory/YYYY-MM-DD.md` میں جائیں۔
- اگر کوئی کہے “اسے یاد رکھو”، تو لکھ دیں (RAM میں نہ رکھیں)۔
- This area is still evolving. It helps to remind the model to store memories; it will know what to do.
- اگر آپ چاہتے ہیں کہ کوئی چیز قائم رہے، **بوٹ سے کہیں کہ اسے میموری میں لکھ دے**۔

## خودکار میموری فلش (پری-کمپیکشن پِنگ)

When a session is **close to auto-compaction**, OpenClaw triggers a **silent,
agentic turn** that reminds the model to write durable memory **before** the
context is compacted. The default prompts explicitly say the model _may reply_,
but usually `NO_REPLY` is the correct response so the user never sees this turn.

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
- Uses remote embeddings by default. If `memorySearch.provider` is not set, OpenClaw auto-selects:
  1. `local` اگر `memorySearch.local.modelPath` کنفیگر ہو اور فائل موجود ہو۔
  2. `openai` اگر OpenAI کلید حل ہو سکے۔
  3. `gemini` اگر Gemini کلید حل ہو سکے۔
  4. `voyage` اگر Voyage کلید حل ہو سکے۔
  5. بصورتِ دیگر کنفیگریشن تک میموری سرچ غیر فعال رہتی ہے۔
- لوکل موڈ node-llama-cpp استعمال کرتا ہے اور `pnpm approve-builds` درکار ہو سکتا ہے۔
- SQLite کے اندر ویکٹر سرچ تیز کرنے کے لیے sqlite-vec (جب دستیاب ہو) استعمال کرتا ہے۔

Remote embeddings **require** an API key for the embedding provider. OpenClaw
resolves keys from auth profiles, `models.providers.*.apiKey`, or environment
variables. Codex OAuth only covers chat/completions and does **not** satisfy
embeddings for memory search. For Gemini, use `GEMINI_API_KEY` or
`models.providers.google.apiKey`. For Voyage, use `VOYAGE_API_KEY` or
`models.providers.voyage.apiKey`. When using a custom OpenAI-compatible endpoint,
set `memorySearch.remote.apiKey` (and optional `memorySearch.remote.headers`).

### QMD بیک اینڈ (تجرباتی)

Set `memory.backend = "qmd"` to swap the built-in SQLite indexer for
[QMD](https://github.com/tobi/qmd): a local-first search sidecar that combines
BM25 + vectors + reranking. Markdown stays the source of truth; OpenClaw shells
out to QMD for retrieval. Key points:

**پیشگی تقاضے**

- Disabled by default. 20. فی کنفیگ آپٹ اِن کریں (`memory.backend = "qmd"`)۔
- QMD CLI الگ سے انسٹال کریں (`bun install -g https://github.com/tobi/qmd` یا
  ریلیز حاصل کریں) اور یقینی بنائیں کہ `qmd` بائنری گیٹ وے کے `PATH` پر موجود ہو۔
- QMD کو ایسی SQLite بلڈ درکار ہے جو ایکسٹینشنز کی اجازت دے (`brew install sqlite` برائے
  macOS)۔
- QMD مکمل طور پر لوکل Bun + `node-llama-cpp` کے ذریعے چلتا ہے اور پہلی بار استعمال پر HuggingFace سے GGUF
  ماڈلز خودکار طور پر ڈاؤن لوڈ کرتا ہے (الگ Ollama ڈیمَن درکار نہیں)۔
- گیٹ وے QMD کو خودمختار XDG ہوم میں
  `~/.openclaw/agents/<agentId>/qmd/` کے تحت چلاتا ہے، `XDG_CONFIG_HOME` اور
  `XDG_CACHE_HOME` سیٹ کر کے۔
- OS support: macOS and Linux work out of the box once Bun + SQLite are
  installed. Windows is best supported via WSL2.

**سائیڈکار کیسے چلتا ہے**

- گیٹ وے ایک خودمختار QMD ہوم
  `~/.openclaw/agents/<agentId>/qmd/` کے تحت لکھتا ہے (کنفیگ + کیش + sqlite DB)۔
- کلیکشنز `qmd collection add` کے ذریعے `memory.qmd.paths` سے بنائے جاتے ہیں
  (اور ڈیفالٹ ورک اسپیس میموری فائلیں)، پھر `qmd update` + `qmd embed` بوٹ پر اور ایک قابلِ کنفیگر وقفے پر چلتے ہیں (`memory.qmd.update.interval`,
  ڈیفالٹ 5 m)۔
- بوٹ ریفریش اب بطورِ طے شدہ بیک گراؤنڈ میں چلتا ہے تاکہ چیٹ اسٹارٹ اپ بلاک نہ ہو؛
  پچھلا بلاکنگ رویہ رکھنے کے لیے `memory.qmd.update.waitForBootSync = true` سیٹ کریں۔
- Searches run via `qmd query --json`. If QMD fails or the binary is missing,
  OpenClaw automatically falls back to the builtin SQLite manager so memory tools
  keep working.
- OpenClaw فی الحال QMD ایمبیڈ بیچ-سائز ٹیوننگ ایکسپوز نہیں کرتا؛ بیچ رویہ
  QMD خود کنٹرول کرتا ہے۔
- **پہلی سرچ سست ہو سکتی ہے**: QMD پہلی `qmd query` رن پر لوکل GGUF ماڈلز (ری رینکر/کوئری ایکسپینشن) ڈاؤن لوڈ کر سکتا ہے۔
  - OpenClaw QMD چلانے پر `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` خودکار طور پر سیٹ کرتا ہے۔
  - اگر آپ ماڈلز دستی طور پر پری-ڈاؤن لوڈ کرنا چاہتے ہیں (اور وہی انڈیکس وارم کریں جو OpenClaw استعمال کرتا ہے)،
    ایجنٹ کے XDG ڈائریکٹریز کے ساتھ ایک وقتی کوئری چلائیں۔

    OpenClaw’s QMD state lives under your **state dir** (defaults to `~/.openclaw`).
    You can point `qmd` at the exact same index by exporting the same XDG vars
    OpenClaw uses:

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
- `scope`: same schema as [`session.sendPolicy`](/gateway/configuration#session).
  Default is DM-only (`deny` all, `allow` direct chats); loosen it to surface QMD
  hits in groups/channels.
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
- When `qmd` runs, we tag `status().backend = "qmd"` so diagnostics show which
  engine served the results. If the QMD subprocess exits or JSON output can’t be
  parsed, the search manager logs a warning and returns the builtin provider
  (existing Markdown embeddings) until QMD recovers.

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

- Enabled by default for OpenAI and Gemini embeddings. Set `agents.defaults.memorySearch.remote.batch.enabled = false` to disable.
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

- `memory_search` semantically searches Markdown chunks (~400 token target, 80-token overlap) from `MEMORY.md` + `memory/**/*.md`. It returns snippet text (capped ~700 chars), file path, line range, score, provider/model, and whether we fell back from local → remote embeddings. No full file payload is returned.
- `memory_get` reads a specific memory Markdown file (workspace-relative), optionally from a starting line and for N lines. Paths outside `MEMORY.md` / `memory/` are rejected.
- دونوں ٹولز صرف اس وقت فعال ہوتے ہیں جب ایجنٹ کے لیے `memorySearch.enabled` درست ثابت ہو۔

### کیا چیز انڈیکس ہوتی ہے (اور کب)

- فائل قسم: صرف Markdown (`MEMORY.md`, `memory/**/*.md`)۔
- انڈیکس اسٹوریج: فی ایجنٹ SQLite، مقام `~/.openclaw/memory/<agentId>.sqlite` (کنفیگ کے ذریعے `agents.defaults.memorySearch.store.path`؛ `{agentId}` ٹوکن سپورٹ)۔
- Freshness: watcher on `MEMORY.md` + `memory/` marks the index dirty (debounce 1.5s). Sync is scheduled on session start, on search, or on an interval and runs asynchronously. Session transcripts use delta thresholds to trigger background sync.
- Reindex triggers: the index stores the embedding **provider/model + endpoint fingerprint + chunking params**. If any of those change, OpenClaw automatically resets and reindexes the entire store.

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

BM25 (full-text) is the opposite: strong at exact tokens, weaker at paraphrases.
Hybrid search is the pragmatic middle ground: **use both retrieval signals** so you get
good results for both “natural language” queries and “needle in a haystack” queries.

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

This isn’t “IR-theory perfect”, but it’s simple, fast, and tends to improve recall/precision on real notes.
If we want to get fancier later, common next steps are Reciprocal Rank Fusion (RRF) or score normalization
(min/max or z-score) before mixing.

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

You can optionally index **session transcripts** and surface them via `memory_search`.
This is gated behind an experimental flag.

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
- Session logs live on disk (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Any process/user with filesystem access can read them, so treat disk access as the trust boundary. For stricter isolation, run agents under separate OS users or hosts.

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

When the sqlite-vec extension is available, OpenClaw stores embeddings in a
SQLite virtual table (`vec0`) and performs vector distance queries in the
database. This keeps search fast without loading every embedding into JS.

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
- When `memorySearch.provider = "local"`, `node-llama-cpp` resolves `modelPath`; if the GGUF is missing it **auto-downloads** to the cache (or `local.modelCacheDir` if set), then loads it. Downloads resume on retry.
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
- `remote.headers` merge with OpenAI headers; remote wins on key conflicts. Omit `remote.headers` to use the OpenAI defaults.
