---
summary: "كيف تعمل ذاكرة OpenClaw (ملفات مساحة العمل + التفريغ التلقائي للذاكرة)"
read_when:
  - تريد تخطيط ملفات الذاكرة وسير العمل
  - تريد ضبط التفريغ التلقائي للذاكرة قبل الدمج
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:05Z
---

# الذاكرة

ذاكرة OpenClaw هي **Markdown عادي داخل مساحة عمل الوكيل**. الملفات هي
مصدر الحقيقة؛ فالنموذج لا «يتذكر» إلا ما يُكتب على القرص.

توفّر أدوات البحث في الذاكرة عبر إضافة الذاكرة النشطة (الافتراضية:
`memory-core`). عطّل إضافات الذاكرة باستخدام `plugins.slots.memory = "none"`.

## ملفات الذاكرة (Markdown)

يستخدم تخطيط مساحة العمل الافتراضي طبقتين من الذاكرة:

- `memory/YYYY-MM-DD.md`
  - سجل يومي (إلحاق فقط).
  - تُقرأ ملاحظات اليوم + الأمس عند بدء الجلسة.
- `MEMORY.md` (اختياري)
  - ذاكرة طويلة الأمد مُنسَّقة.
  - **تُحمَّل فقط في الجلسة الرئيسية الخاصة** (ولا تُحمَّل أبدًا في سياقات جماعية).

توجد هذه الملفات تحت مساحة العمل (`agents.defaults.workspace`، الافتراضي
`~/.openclaw/workspace`). راجع [مساحة عمل الوكيل](/concepts/agent-workspace) للتخطيط الكامل.

## متى تكتب الذاكرة

- القرارات والتفضيلات والحقائق الدائمة تذهب إلى `MEMORY.md`.
- الملاحظات اليومية والسياق الجاري تذهب إلى `memory/YYYY-MM-DD.md`.
- إذا قال شخص «تذكّر هذا»، فاكتبه (لا تُبقِه في الذاكرة المؤقتة).
- هذا المجال ما يزال قيد التطور. من المفيد تذكير النموذج بتخزين الذكريات؛ فهو يعرف ما الذي يجب فعله.
- إذا أردت أن يثبت شيء ما، **اطلب من البوت كتابته** في الذاكرة.

## التفريغ التلقائي للذاكرة (تنبيه ما قبل الدمج)

عندما تقترب الجلسة من **الدمج التلقائي**، يطلق OpenClaw **دورًا صامتًا
وكيليًا** يذكّر النموذج بكتابة الذاكرة الدائمة **قبل** ضغط السياق. تشير المطالبات الافتراضية صراحةً إلى أن النموذج _قد يرد_،
لكن غالبًا ما تكون `NO_REPLY` هي الاستجابة الصحيحة بحيث لا يرى المستخدم هذا الدور.

يتم التحكم بذلك عبر `agents.defaults.compaction.memoryFlush`:

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

تفاصيل:

- **الحد اللين**: يُطلق التفريغ عندما يتجاوز تقدير رموز الجلسة
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **صامت افتراضيًا**: تتضمن المطالبات `NO_REPLY` بحيث لا يُسلَّم شيء.
- **مطلبان**: مطالبة مستخدم بالإضافة إلى مطالبة نظام تُلحِق التذكير.
- **تفريغ واحد لكل دورة دمج** (يُتتبَّع في `sessions.json`).
- **يجب أن تكون مساحة العمل قابلة للكتابة**: إذا كانت الجلسة تعمل ضمن sandbox مع
  `workspaceAccess: "ro"` أو `"none"`، فيُتخطّى التفريغ.

للاطلاع على دورة حياة الدمج كاملةً، راجع
[إدارة الجلسات + الدمج](/reference/session-management-compaction).

## البحث المتجهي في الذاكرة

يمكن لـ OpenClaw بناء فهرس متجهي صغير فوق `MEMORY.md` و `memory/*.md` بحيث
تتمكن الاستعلامات الدلالية من العثور على ملاحظات ذات صلة حتى عند اختلاف الصياغة.

الافتراضيات:

- مُمكَّن افتراضيًا.
- يراقب ملفات الذاكرة بحثًا عن تغييرات (مع إزالة الارتداد).
- يستخدم تضمينات بعيدة افتراضيًا. إذا لم يتم تعيين `memorySearch.provider`، يختار OpenClaw تلقائيًا:
  1. `local` إذا كان `memorySearch.local.modelPath` مُهيّأً والملف موجودًا.
  2. `openai` إذا أمكن حل مفتاح OpenAI.
  3. `gemini` إذا أمكن حل مفتاح Gemini.
  4. `voyage` إذا أمكن حل مفتاح Voyage.
  5. وإلا يبقى البحث في الذاكرة معطّلًا حتى تتم التهيئة.
- يستخدم الوضع المحلي node-llama-cpp وقد يتطلب `pnpm approve-builds`.
- يستخدم sqlite-vec (عند توفره) لتسريع البحث المتجهي داخل SQLite.

تتطلب التضمينات البعيدة **وجود** مفتاح API لمزوّد التضمين. يحلّ OpenClaw
المفاتيح من ملفات تعريف المصادقة، أو `models.providers.*.apiKey`، أو متغيرات
البيئة. لا يغطي Codex OAuth سوى الدردشة/الإكمالات ولا **يلبّي**
متطلبات التضمينات للبحث في الذاكرة. بالنسبة إلى Gemini، استخدم `GEMINI_API_KEY` أو
`models.providers.google.apiKey`. وبالنسبة إلى Voyage، استخدم `VOYAGE_API_KEY` أو
`models.providers.voyage.apiKey`. عند استخدام نقطة نهاية مخصّصة متوافقة مع OpenAI،
اضبط `memorySearch.remote.apiKey` (و `memorySearch.remote.headers` اختياريًا).

### خلفية QMD (تجريبية)

اضبط `memory.backend = "qmd"` لاستبدال مفهرس SQLite المدمج بـ
[QMD](https://github.com/tobi/qmd): مكوّن بحث محلي أولًا يجمع
BM25 + المتجهات + إعادة الترتيب. يبقى Markdown مصدر الحقيقة؛ ويستدعي OpenClaw
QMD للاسترجاع. نقاط أساسية:

**المتطلبات المسبقة**

- معطّل افتراضيًا. اشترك لكل تهيئة (`memory.backend = "qmd"`).
- ثبّت QMD CLI بشكل منفصل (`bun install -g https://github.com/tobi/qmd` أو احصل على
  إصدار) وتأكد من أن ثنائية `qmd` موجودة على `PATH` للبوابة.
- يحتاج QMD إلى بناء SQLite يسمح بالامتدادات (`brew install sqlite` على
  macOS).
- يعمل QMD محليًا بالكامل عبر Bun + `node-llama-cpp` ويقوم بتنزيل نماذج GGUF تلقائيًا
  من HuggingFace عند أول استخدام (لا يلزم وجود خدمة Ollama منفصلة).
- تشغّل البوابة QMD ضمن منزل XDG مستقل تحت
  `~/.openclaw/agents/<agentId>/qmd/` عبر تعيين `XDG_CONFIG_HOME` و
  `XDG_CACHE_HOME`.
- دعم أنظمة التشغيل: يعمل macOS وLinux مباشرةً بمجرد تثبيت Bun + SQLite.
  يُفضَّل دعم Windows عبر WSL2.

**كيفية عمل المكوّن الجانبي**

- تكتب البوابة منزل QMD مستقلًا تحت
  `~/.openclaw/agents/<agentId>/qmd/` (تهيئة + ذاكرة مؤقتة + قاعدة بيانات sqlite).
- تُنشأ المجموعات عبر `qmd collection add` من `memory.qmd.paths`
  (بالإضافة إلى ملفات ذاكرة مساحة العمل الافتراضية)، ثم يعمل `qmd update` + `qmd embed`
  عند الإقلاع وعلى فاصل زمني قابل للتهيئة (`memory.qmd.update.interval`،
  الافتراضي 5 دقائق).
- يعمل تحديث الإقلاع الآن في الخلفية افتراضيًا حتى لا يُحجب بدء الدردشة؛
  اضبط `memory.qmd.update.waitForBootSync = true` للاحتفاظ بسلوك الحجب السابق.
- تُنفَّذ عمليات البحث عبر `qmd query --json`. إذا فشل QMD أو كانت الثنائية مفقودة،
  يعود OpenClaw تلقائيًا إلى مدير SQLite المدمج حتى تستمر أدوات الذاكرة بالعمل.
- لا يعرِض OpenClaw اليوم ضبط حجم دفعات التضمين في QMD؛
  يتحكم QMD نفسه في سلوك الدُفعات.
- **قد يكون البحث الأول بطيئًا**: قد يقوم QMD بتنزيل نماذج GGUF المحلية
  (إعادة ترتيب/توسيع الاستعلام) عند أول تشغيل لـ `qmd query`.
  - يضبط OpenClaw `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` تلقائيًا عند تشغيل QMD.
  - إذا أردت تنزيل النماذج مسبقًا يدويًا (وتسخين الفهرس نفسه الذي يستخدمه OpenClaw)،
    نفّذ استعلامًا لمرة واحدة باستخدام مجلدات XDG الخاصة بالوكيل.

    تعيش حالة QMD الخاصة بـ OpenClaw تحت **دليل الحالة** لديك (الافتراضي `~/.openclaw`).
    يمكنك توجيه `qmd` إلى الفهرس نفسه تمامًا عبر تصدير متغيرات XDG نفسها
    التي يستخدمها OpenClaw:

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

**سطح التهيئة (`memory.qmd.*`)**

- `command` (الافتراضي `qmd`): تجاوز مسار التنفيذ.
- `includeDefaultMemory` (الافتراضي `true`): فهرسة تلقائية لـ `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: إضافة أدلة/ملفات إضافية (`path`، اختياري `pattern`، اختياري
  ثابت `name`).
- `sessions`: الاشتراك في فهرسة JSONL للجلسات (`enabled`، `retentionDays`،
  `exportDir`).
- `update`: يتحكم في وتيرة التحديث وتنفيذ الصيانة:
  (`interval`، `debounceMs`، `onBoot`، `waitForBootSync`، `embedInterval`،
  `commandTimeoutMs`، `updateTimeoutMs`، `embedTimeoutMs`).
- `limits`: تقييد حمولة الاستدعاء (`maxResults`، `maxSnippetChars`،
  `maxInjectedChars`، `timeoutMs`).
- `scope`: المخطط نفسه كما في [`session.sendPolicy`](/gateway/configuration#session).
  الافتراضي هو الرسائل المباشرة فقط (DM) (`deny` الكل، `allow` الدردشات المباشرة)؛
  قم بتوسيعه لإظهار نتائج QMD في المجموعات/القنوات.
- المقاطع المأخوذة من خارج مساحة العمل تظهر باسم
  `qmd/<collection>/<relative-path>` في نتائج `memory_search`؛ ويفهم `memory_get`
  هذا البادئة ويقرأ من جذر مجموعة QMD المُهيّأة.
- عند `memory.qmd.sessions.enabled = true`، يصدّر OpenClaw سجلات الجلسات المُنقّاة
  (أدوار المستخدم/المساعد) إلى مجموعة QMD مخصّصة تحت
  `~/.openclaw/agents/<id>/qmd/sessions/`، بحيث يمكن لـ `memory_search` استدعاء
  المحادثات الأخيرة دون لمس فهرس SQLite المدمج.
- تتضمن مقاطع `memory_search` الآن تذييل `Source: <path#line>` عندما
  تكون `memory.citations` هي `auto`/`on`؛ اضبط `memory.citations = "off"` للاحتفاظ
  ببيانات المسار داخلية (لا يزال الوكيل يتلقى المسار لأجل
  `memory_get`، لكن نص المقطع يحذف التذييل ويُحذّر مطلب النظام
  الوكيل من الاستشهاد به).

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

**الاستشهادات والرجوع الاحتياطي**

- تنطبق `memory.citations` بغضّ النظر عن الخلفية (`auto`/`on`/`off`).
- عند تشغيل `qmd`، نوسم `status().backend = "qmd"` بحيث تُظهر
  التشخيصات أي محرّك قدّم النتائج. إذا خرجت عملية QMD الفرعية أو تعذّر تحليل خرج JSON،
  يسجّل مدير البحث تحذيرًا ويعيد المزوّد المدمج
  (تضمينات Markdown الحالية) حتى يتعافى QMD.

### مسارات ذاكرة إضافية

إذا أردت فهرسة ملفات Markdown خارج تخطيط مساحة العمل الافتراضي، أضف
مسارات صريحة:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

ملاحظات:

- يمكن أن تكون المسارات مطلقة أو نسبية لمساحة العمل.
- تُفحَص الأدلة تكراريًا بحثًا عن ملفات `.md`.
- تُفهرس ملفات Markdown فقط.
- يتم تجاهل الروابط الرمزية (ملفات أو أدلة).

### تضمينات Gemini (أصلية)

اضبط المزوّد إلى `gemini` لاستخدام واجهة Gemini للتضمينات مباشرةً:

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

ملاحظات:

- `remote.baseUrl` اختياري (الافتراضي عنوان قاعدة واجهة Gemini).
- يتيح `remote.headers` إضافة ترويسات إضافية عند الحاجة.
- النموذج الافتراضي: `gemini-embedding-001`.

إذا أردت استخدام **نقطة نهاية مخصّصة متوافقة مع OpenAI** (OpenRouter أو vLLM أو وكيل)،
يمكنك استخدام تهيئة `remote` مع مزوّد OpenAI:

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

إذا لم ترغب في تعيين مفتاح API، استخدم `memorySearch.provider = "local"` أو اضبط
`memorySearch.fallback = "none"`.

الرجوعيات الاحتياطية:

- يمكن أن تكون `memorySearch.fallback` واحدة من `openai` أو `gemini` أو `local` أو `none`.
- يُستخدم المزوّد الاحتياطي فقط عندما يفشل مزوّد التضمين الأساسي.

الفهرسة بالدُفعات (OpenAI + Gemini):

- مُمكَّنة افتراضيًا لتضمينات OpenAI وGemini. اضبط `agents.defaults.memorySearch.remote.batch.enabled = false` للتعطيل.
- ينتظر السلوك الافتراضي اكتمال الدُفعة؛ اضبط `remote.batch.wait` و `remote.batch.pollIntervalMs` و `remote.batch.timeoutMinutes` إذا لزم.
- اضبط `remote.batch.concurrency` للتحكم في عدد مهام الدُفعات المتوازية (الافتراضي: 2).
- يُطبَّق وضع الدُفعات عندما تكون `memorySearch.provider = "openai"` أو `"gemini"` وتستخدم مفتاح API الموافق.
- تستخدم مهام دُفعات Gemini نقطة نهاية الدُفعات غير المتزامنة للتضمينات وتتطلب توفر واجهة Gemini Batch API.

لماذا تُعد دُفعات OpenAI سريعة ورخيصة:

- لعمليات الإرجاع الكبيرة، تكون OpenAI عادةً الخيار الأسرع الذي ندعمه لأننا نستطيع إرسال العديد من طلبات التضمين في مهمة دُفعة واحدة وترك OpenAI تعالجها بشكل غير متزامن.
- تقدّم OpenAI تسعيرًا مخفّضًا لأحمال عمل Batch API، لذا تكون عمليات الفهرسة الكبيرة عادةً أرخص من إرسال الطلبات نفسها بشكل متزامن.
- راجع مستندات وتسعير OpenAI Batch API للتفاصيل:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

مثال تهيئة:

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

الأدوات:

- `memory_search` — يعيد مقاطع مع الملف + نطاقات الأسطر.
- `memory_get` — قراءة محتوى ملف ذاكرة حسب المسار.

الوضع المحلي:

- اضبط `agents.defaults.memorySearch.provider = "local"`.
- قدّم `agents.defaults.memorySearch.local.modelPath` (GGUF أو URI لـ `hf:`).
- اختياري: اضبط `agents.defaults.memorySearch.fallback = "none"` لتجنب الرجوع الاحتياطي البعيد.

### كيف تعمل أدوات الذاكرة

- يجري `memory_search` بحثًا دلاليًا في مقاطع Markdown (~هدف 400 رمز، تداخل 80 رمزًا) من `MEMORY.md` + `memory/**/*.md`. يعيد نص المقطع (محدود ~700 حرف)، ومسار الملف، ونطاق الأسطر، والدرجة، والمزوّد/النموذج، وما إذا كنا قد رجعنا من تضمينات محلية → بعيدة. لا يُعاد حمولة ملف كاملة.
- يقرأ `memory_get` ملف ذاكرة Markdown محددًا (نسبيًا لمساحة العمل)، اختياريًا من سطر بداية ولمدة N أسطر. تُرفض المسارات خارج `MEMORY.md` / `memory/`.
- تُفعَّل الأداتان فقط عندما تتحقق `memorySearch.enabled` للوكيل.

### ما الذي يُفهرس (ومتى)

- نوع الملف: Markdown فقط (`MEMORY.md`، `memory/**/*.md`).
- تخزين الفهرس: SQLite لكل وكيل في `~/.openclaw/memory/<agentId>.sqlite` (قابل للتهيئة عبر `agents.defaults.memorySearch.store.path`، ويدعم رمز `{agentId}`).
- الحداثة: يعلّم المراقِب على `MEMORY.md` + `memory/` الفهرس على أنه متّسخ (إزالة ارتداد 1.5 ثانية). تُجدول المزامنة عند بدء الجلسة، أو عند البحث، أو على فاصل زمني وتعمل بشكل غير متزامن. تستخدم سجلات الجلسات عتبات دلتا لإطلاق مزامنة خلفية.
- محفزات إعادة الفهرسة: يخزّن الفهرس **المزوّد/النموذج + بصمة نقطة النهاية + معاملات التجزئة**. إذا تغيّر أيّ منها، يعيد OpenClaw الضبط ويُعيد فهرسة المخزن بالكامل تلقائيًا.

### البحث الهجين (BM25 + متجه)

عند التمكين، يجمع OpenClaw بين:

- **تشابه المتجه** (تطابق دلالي، يمكن أن تختلف الصياغة)
- **ملاءمة كلمات BM25** (رموز دقيقة مثل المعرّفات ومتغيرات البيئة ورموز الشيفرة)

إذا لم يتوفر البحث النصي الكامل على منصتك، يعود OpenClaw إلى البحث المتجهي فقط.

#### لماذا الهجين؟

البحث المتجهي ممتاز في «هذا يعني الشيء نفسه»:

- «مضيف بوابة Mac Studio» مقابل «الآلة التي تشغّل البوابة»
- «إزالة ارتداد تحديثات الملفات» مقابل «تجنب الفهرسة عند كل كتابة»

لكنه قد يكون ضعيفًا مع الرموز الدقيقة عالية الإشارة:

- المعرّفات (`a828e60`، `b3b9895a…`)
- رموز الشيفرة (`memorySearch.query.hybrid`)
- سلاسل الأخطاء («sqlite-vec unavailable»)

BM25 (النص الكامل) عكس ذلك: قوي في الرموز الدقيقة، أضعف في إعادة الصياغة.
البحث الهجين هو الحل الوسط العملي: **استخدم إشارات الاسترجاع كليهما** لتحصل على
نتائج جيدة لاستعلامات «اللغة الطبيعية» و«إبرة في كومة قش».

#### كيف ندمج النتائج (التصميم الحالي)

مخطط التنفيذ:

1. استرجاع مجموعة مرشحين من الجانبين:

- **المتجه**: أعلى `maxResults * candidateMultiplier` حسب تشابه جيب التمام.
- **BM25**: أعلى `maxResults * candidateMultiplier` حسب ترتيب FTS5 BM25 (الأقل أفضل).

2. تحويل ترتيب BM25 إلى درجة تقريبية 0..1:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. توحيد المرشحين حسب معرّف المقطع وحساب درجة موزونة:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

ملاحظات:

- يتم تطبيع `vectorWeight` + `textWeight` إلى 1.0 عند حل التهيئة، لذا تتصرف الأوزان كنِسَب مئوية.
- إذا كانت التضمينات غير متاحة (أو أعاد المزوّد متجهًا صفريًا)، ما زلنا نشغّل BM25 ونعيد تطابقات الكلمات المفتاحية.
- إذا تعذّر إنشاء FTS5، نحتفظ بالبحث المتجهي فقط (من دون فشل قاسٍ).

هذا ليس «مثاليًا نظريًا في الاسترجاع»، لكنه بسيط وسريع وغالبًا ما يحسّن الاستدعاء/الدقة على ملاحظات حقيقية.
إذا أردنا التوسّع لاحقًا، فخطوات شائعة تالية هي دمج الترتيب التبادلي (RRF) أو تطبيع الدرجات
(الحد الأدنى/الأقصى أو z-score) قبل المزج.

التهيئة:

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

### ذاكرة التخزين المؤقت للتضمين

يمكن لـ OpenClaw تخزين **تضمينات المقاطع** مؤقتًا في SQLite بحيث لا تعيد الفهرسة
والتحديثات المتكررة (خاصةً سجلات الجلسات) تضمين النص غير المتغير.

التهيئة:

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

### البحث في ذاكرة الجلسة (تجريبي)

يمكنك اختياريًا فهرسة **سجلات الجلسات** وإظهارها عبر `memory_search`.
هذا خلف راية تجريبية.

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

ملاحظات:

- فهرسة الجلسات **اختيارية** (موقوفة افتراضيًا).
- تُزال ارتدادات تحديثات الجلسة وتُفهرس **بشكل غير متزامن** بمجرد تجاوز عتبات الدلتا (بأفضل جهد).
- لا يحجب `memory_search` أبدًا بانتظار الفهرسة؛ قد تكون النتائج قديمة قليلًا حتى تكتمل المزامنة الخلفية.
- ما تزال النتائج تتضمن مقاطع فقط؛ ويبقى `memory_get` محدودًا بملفات الذاكرة.
- فهرسة الجلسات معزولة لكل وكيل (لا تُفهرس إلا سجلات جلسات ذلك الوكيل).
- تعيش سجلات الجلسات على القرص (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). يمكن لأي عملية/مستخدم لديه وصول لنظام الملفات قراءتها، لذا اعتبر الوصول للقرص حدّ الثقة. لعزل أشد، شغّل الوكلاء تحت مستخدمي نظام تشغيل أو مضيفين منفصلين.

عتبات الدلتا (القيم الافتراضية معروضة):

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

### تسريع المتجهات في SQLite (sqlite-vec)

عندما يتوفر امتداد sqlite-vec، يخزّن OpenClaw التضمينات في
جدول افتراضي لـ SQLite (`vec0`) ويجري استعلامات مسافة المتجه
داخل قاعدة البيانات. يحافظ ذلك على سرعة البحث دون تحميل كل تضمين إلى JS.

التهيئة (اختياري):

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

ملاحظات:

- الافتراضي لـ `enabled` هو true؛ عند التعطيل يعود البحث إلى
  تشابه جيب التمام داخل العملية على التضمينات المخزّنة.
- إذا كان امتداد sqlite-vec مفقودًا أو فشل تحميله، يسجّل OpenClaw
  الخطأ ويتابع مع الرجوع الاحتياطي لـ JS (من دون جدول متجه).
- يتجاوز `extensionPath` مسار sqlite-vec المضمّن (مفيد للبناءات المخصّصة
  أو مواقع التثبيت غير القياسية).

### التنزيل التلقائي للتضمين المحلي

- نموذج التضمين المحلي الافتراضي: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 غيغابايت).
- عند `memorySearch.provider = "local"`، يحلّ `node-llama-cpp` إلى `modelPath`؛ إذا كان GGUF مفقودًا فإنه **يُنزَّل تلقائيًا** إلى الذاكرة المؤقتة (أو `local.modelCacheDir` إذا عُيّن)، ثم يُحمَّل. تُستأنف التنزيلات عند إعادة المحاولة.
- متطلب البناء الأصلي: شغّل `pnpm approve-builds`، اختر `node-llama-cpp`، ثم `pnpm rebuild node-llama-cpp`.
- الرجوع الاحتياطي: إذا فشل الإعداد المحلي وكانت `memorySearch.fallback = "openai"`، ننتقل تلقائيًا إلى التضمينات البعيدة (`openai/text-embedding-3-small` ما لم يُتجاوز) ونسجّل السبب.

### مثال نقطة نهاية مخصّصة متوافقة مع OpenAI

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

ملاحظات:

- لـ `remote.*` أولوية على `models.providers.openai.*`.
- تندمج `remote.headers` مع ترويسات OpenAI؛ ويتغلب البعيد عند تعارض المفاتيح. احذف `remote.headers` لاستخدام افتراضيات OpenAI.
