---
summary: "OpenClaw मेमोरी कैसे काम करती है (वर्कस्पेस फ़ाइलें + स्वचालित मेमोरी फ़्लश)"
read_when:
  - आप मेमोरी फ़ाइल लेआउट और वर्कफ़्लो चाहते हैं
  - आप स्वचालित प्री-कम्पैक्शन मेमोरी फ़्लश को ट्यून करना चाहते हैं
---

# Memory

OpenClaw मेमोरी **एजेंट वर्कस्पेस में साधारण Markdown** होती है। फ़ाइलें ही
सत्य का स्रोत हैं; मॉडल केवल वही "याद" रखता है जो डिस्क पर लिखा जाता है।

मेमोरी सर्च टूल्स सक्रिय मेमोरी प्लगइन द्वारा प्रदान किए जाते हैं (डिफ़ॉल्ट:
`memory-core`)। `plugins.slots.memory = "none"` के साथ मेमोरी प्लगइन्स अक्षम करें।

## Memory files (Markdown)

डिफ़ॉल्ट वर्कस्पेस लेआउट दो मेमोरी लेयर्स का उपयोग करता है:

- `memory/YYYY-MM-DD.md`
  - दैनिक लॉग (केवल जोड़ने योग्य)।
  - सत्र प्रारंभ पर आज + कल पढ़ता है।
- `MEMORY.md` (वैकल्पिक)
  - क्यूरेटेड दीर्घकालिक मेमोरी।
  - **केवल मुख्य, निजी सत्र में लोड करें** (समूह संदर्भों में कभी नहीं)।

ये फ़ाइलें वर्कस्पेस के अंतर्गत रहती हैं (`agents.defaults.workspace`, डिफ़ॉल्ट
`~/.openclaw/workspace`)। पूर्ण लेआउट के लिए [Agent workspace](/concepts/agent-workspace) देखें।

## When to write memory

- निर्णय, प्राथमिकताएँ, और स्थायी तथ्य `MEMORY.md` में जाएँ।
- रोज़मर्रा के नोट्स और चल रहा संदर्भ `memory/YYYY-MM-DD.md` में जाएँ।
- यदि कोई कहता है “इसे याद रखो,” तो इसे लिख दें (RAM में न रखें)।
- यह क्षेत्र अभी विकसित हो रहा है। मॉडल को मेमोरी स्टोर करने की याद दिलाना मददगार होता है; वह जानता है कि क्या करना है।
- यदि आप चाहते हैं कि कुछ टिके, **बॉट से उसे मेमोरी में लिखने को कहें**।

## Automatic memory flush (pre-compaction ping)

जब कोई सेशन **ऑटो-कम्पैक्शन के क़रीब** होता है, OpenClaw एक **साइलेंट,
एजेंटिक टर्न** ट्रिगर करता है जो मॉडल को संदर्भ कम्पैक्ट होने से **पहले** स्थायी मेमोरी लिखने की याद दिलाता है। डिफ़ॉल्ट प्रॉम्प्ट्स स्पष्ट रूप से कहते हैं कि मॉडल _may reply_,
लेकिन आमतौर पर `NO_REPLY` ही सही प्रतिक्रिया होती है ताकि उपयोगकर्ता को यह टर्न कभी दिखाई न दे।

इसे `agents.defaults.compaction.memoryFlush` द्वारा नियंत्रित किया जाता है:

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

विवरण:

- **Soft threshold**: फ़्लश तब ट्रिगर होता है जब सत्र टोकन अनुमान
  `contextWindow - reserveTokensFloor - softThresholdTokens` को पार करता है।
- **डिफ़ॉल्ट रूप से मौन**: प्रॉम्प्ट में `NO_REPLY` शामिल होता है ताकि कुछ भी डिलीवर न हो।
- **दो प्रॉम्प्ट**: एक उपयोगकर्ता प्रॉम्प्ट और एक सिस्टम प्रॉम्प्ट रिमाइंडर जोड़ते हैं।
- **प्रति कम्पैक्शन चक्र एक फ़्लश** (`sessions.json` में ट्रैक किया गया)।
- **वर्कस्पेस लिखने योग्य होना चाहिए**: यदि सत्र sandboxed में
  `workspaceAccess: "ro"` या `"none"` के साथ चलता है, तो फ़्लश छोड़ दिया जाता है।

पूर्ण कम्पैक्शन लाइफ़साइकल के लिए देखें
[Session management + compaction](/reference/session-management-compaction)।

## Vector memory search

OpenClaw `MEMORY.md` और `memory/*.md` पर एक छोटा वेक्टर इंडेक्स बना सकता है ताकि
शब्दावली अलग होने पर भी सेमांटिक क्वेरी संबंधित नोट्स खोज सकें।

डिफ़ॉल्ट्स:

- डिफ़ॉल्ट रूप से सक्षम।
- मेमोरी फ़ाइलों में बदलावों पर नज़र रखता है (debounced)।
- डिफ़ॉल्ट रूप से रिमोट एम्बेडिंग्स का उपयोग करता है। यदि `memorySearch.provider` सेट नहीं है, तो OpenClaw स्वतः चयन करता है:
  1. `local` यदि `memorySearch.local.modelPath` कॉन्फ़िगर है और फ़ाइल मौजूद है।
  2. `openai` यदि OpenAI कुंजी सुलझाई जा सकती है।
  3. `gemini` यदि Gemini कुंजी सुलझाई जा सकती है।
  4. `voyage` यदि Voyage कुंजी सुलझाई जा सकती है।
  5. अन्यथा, कॉन्फ़िगर होने तक मेमोरी खोज अक्षम रहती है।
- Local मोड node-llama-cpp का उपयोग करता है और `pnpm approve-builds` की आवश्यकता हो सकती है।
- SQLite के भीतर वेक्टर खोज को तेज़ करने के लिए sqlite-vec (उपलब्ध होने पर) का उपयोग करता है।

रिमोट एम्बेडिंग्स के लिए एम्बेडिंग प्रदाता का API की **आवश्यक** है। OpenClaw
ऑथ प्रोफ़ाइल्स, `models.providers.*.apiKey`, या एनवायरनमेंट
वेरिएबल्स से कीज़ रेज़ॉल्व करता है। Codex OAuth केवल चैट/कम्प्लीशन्स को कवर करता है और मेमोरी सर्च के लिए एम्बेडिंग्स को **पूरा नहीं** करता। Gemini के लिए `GEMINI_API_KEY` या
`models.providers.google.apiKey` का उपयोग करें। Voyage के लिए `VOYAGE_API_KEY` या
`models.providers.voyage.apiKey` का उपयोग करें। कस्टम OpenAI-कम्पैटिबल एंडपॉइंट का उपयोग करते समय,
`memorySearch.remote.apiKey` (और वैकल्पिक `memorySearch.remote.headers`) सेट करें।

### QMD backend (experimental)

बिल्ट-इन SQLite इंडेक्सर को बदलकर
[QMD](https://github.com/tobi/qmd) उपयोग करने के लिए `memory.backend = "qmd"` सेट करें: एक लोकल-फ़र्स्ट सर्च साइडकार जो
BM25 + वेक्टर्स + री-रैंकिंग को जोड़ता है। Markdown सत्य का स्रोत बना रहता है; रिट्रीवल के लिए OpenClaw QMD को शेल आउट करता है। मुख्य बिंदु:

**Prereqs**

- डिफ़ॉल्ट रूप से अक्षम। प्रति-कॉन्फ़िग ऑप्ट-इन (`memory.backend = "qmd"`)।
- QMD CLI अलग से इंस्टॉल करें (`bun install -g https://github.com/tobi/qmd` या
  कोई रिलीज़ लें) और सुनिश्चित करें कि `qmd` बाइनरी Gateway के `PATH` पर है।
- QMD को ऐसे SQLite बिल्ड की आवश्यकता है जो एक्सटेंशन्स की अनुमति देता हो (`brew install sqlite` on
  macOS)।
- QMD Bun + `node-llama-cpp` के माध्यम से पूरी तरह लोकल चलता है और पहली उपयोग पर HuggingFace से
  GGUF मॉडल ऑटो-डाउनलोड करता है (अलग Ollama डेमन आवश्यक नहीं)।
- Gateway, QMD को एक self-contained XDG होम में
  `~/.openclaw/agents/<agentId>/qmd/` के तहत चलाता है, इसके लिए `XDG_CONFIG_HOME` और
  `XDG_CACHE_HOME` सेट करता है।
- OS support: macOS and Linux work out of the box once Bun + SQLite are
  installed. Windows को WSL2 के माध्यम से सबसे बेहतर सपोर्ट मिलता है।

**How the sidecar runs**

- Gateway एक self-contained QMD होम
  `~/.openclaw/agents/<agentId>/qmd/` के तहत लिखता है (config + cache + sqlite DB)।
- कलेक्शन्स `qmd collection add` के माध्यम से `memory.qmd.paths`
  (और डिफ़ॉल्ट वर्कस्पेस मेमोरी फ़ाइलें) से बनाई जाती हैं, फिर `qmd update` + `qmd embed` बूट पर और एक कॉन्फ़िगर योग्य अंतराल पर (`memory.qmd.update.interval`,
  डिफ़ॉल्ट 5 m) चलते हैं।
- बूट रिफ़्रेश अब डिफ़ॉल्ट रूप से बैकग्राउंड में चलता है ताकि चैट स्टार्टअप ब्लॉक न हो; पिछले
  ब्लॉकिंग व्यवहार को बनाए रखने के लिए `memory.qmd.update.waitForBootSync = true` सेट करें।
- सर्च `qmd query --json` के माध्यम से चलती हैं। यदि QMD विफल हो जाए या बाइनरी गायब हो,
  OpenClaw स्वतः बिल्ट-इन SQLite मैनेजर पर फ़ॉलबैक कर देता है ताकि मेमोरी टूल्स काम करते रहें।
- OpenClaw आज QMD एम्बेड बैच-साइज़ ट्यूनिंग एक्सपोज़ नहीं करता; बैच व्यवहार
  QMD द्वारा ही नियंत्रित होता है।
- **पहली खोज धीमी हो सकती है**: QMD पहली `qmd query` रन पर लोकल GGUF मॉडल (री-रैंकर/क्वेरी
  एक्सपैंशन) डाउनलोड कर सकता है।
  - OpenClaw QMD चलाते समय `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` स्वतः सेट करता है।
  - यदि आप मॉडल्स को मैन्युअली प्री-डाउनलोड करना चाहते हैं (और वही इंडेक्स वार्म करना चाहते हैं जिसे OpenClaw
    उपयोग करता है), तो एजेंट की XDG डाइरेक्टरीज़ के साथ एक वन-ऑफ़ क्वेरी चलाएँ।

    OpenClaw की QMD स्टेट आपके **स्टेट डिरेक्टरी** के अंतर्गत रहती है (डिफ़ॉल्ट `~/.openclaw`)।
    आप वही XDG वेरिएबल्स एक्सपोर्ट करके `qmd` को बिल्कुल उसी इंडेक्स की ओर इंगित कर सकते हैं जिन्हें OpenClaw उपयोग करता है:

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

**Config surface (`memory.qmd.*`)**

- `command` (डिफ़ॉल्ट `qmd`): executable पथ ओवरराइड करें।
- `includeDefaultMemory` (डिफ़ॉल्ट `true`): `MEMORY.md` + `memory/**/*.md` को ऑटो-इंडेक्स करें।
- `paths[]`: अतिरिक्त डाइरेक्टरी/फ़ाइलें जोड़ें (`path`, वैकल्पिक `pattern`, वैकल्पिक
  स्थिर `name`)।
- `sessions`: सत्र JSONL इंडेक्सिंग में ऑप्ट-इन (`enabled`, `retentionDays`,
  `exportDir`)।
- `update`: रिफ़्रेश कैडेंस और मेंटेनेंस एक्ज़ीक्यूशन नियंत्रित करता है:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`)।
- `limits`: रिकॉल पेलोड क्लैम्प (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`)।
- `scope`: [`session.sendPolicy`](/gateway/configuration#session) जैसा ही स्कीमा।
  डिफ़ॉल्ट DM-only है (`deny` सभी, `allow` डायरेक्ट चैट्स); इसे ढीला करें ताकि समूहों/चैनलों में QMD हिट्स दिखाई दें।
- वर्कस्पेस के बाहर से सोर्स किए गए स्निपेट्स `memory_search` परिणामों में
  `qmd/<collection>/<relative-path>` के रूप में दिखाई देते हैं; `memory_get`
  उस प्रीफ़िक्स को समझता है और कॉन्फ़िगर किए गए QMD कलेक्शन रूट से पढ़ता है।
- जब `memory.qmd.sessions.enabled = true`, OpenClaw sanitized सत्र
  ट्रांसक्रिप्ट्स (User/Assistant टर्न्स) को एक समर्पित QMD कलेक्शन में
  `~/.openclaw/agents/<id>/qmd/sessions/` के तहत एक्सपोर्ट करता है, ताकि `memory_search` हाल की
  बातचीतों को बिना बिल्ट-इन SQLite इंडेक्स को छुए रिकॉल कर सके।
- `memory_search` स्निपेट्स अब `Source: <path#line>` फ़ूटर शामिल करते हैं जब
  `memory.citations` `auto`/`on` हो; पाथ मेटाडेटा को आंतरिक रखने के लिए `memory.citations = "off"` सेट करें
  (एजेंट अभी भी `memory_get` के लिए पाथ प्राप्त करता है, लेकिन स्निपेट टेक्स्ट फ़ूटर छोड़ देता है और सिस्टम प्रॉम्प्ट
  एजेंट को इसे उद्धृत न करने की चेतावनी देता है)।

**Example**

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

**Citations & fallback**

- `memory.citations` बैकएंड की परवाह किए बिना लागू होता है (`auto`/`on`/`off`)।
- जब `qmd` चलता है, तो हम `status().backend = "qmd"` टैग करते हैं ताकि डायग्नॉस्टिक्स दिखा सकें कि परिणाम किस इंजन ने सर्व किए। यदि QMD सबप्रोसेस समाप्त हो जाए या JSON आउटपुट पार्स न हो सके,
  सर्च मैनेजर एक चेतावनी लॉग करता है और QMD के रिकवर होने तक बिल्ट-इन प्रदाता
  (मौजूदा Markdown एम्बेडिंग्स) लौटाता है।

### Additional memory paths

यदि आप डिफ़ॉल्ट वर्कस्पेस लेआउट के बाहर Markdown फ़ाइलों को इंडेक्स करना चाहते हैं, तो
स्पष्ट पाथ जोड़ें:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

नोट्स:

- पाथ्स पूर्ण या वर्कस्पेस-रिलेटिव हो सकते हैं।
- डाइरेक्टरीज़ `.md` फ़ाइलों के लिए रिकर्सिवली स्कैन की जाती हैं।
- केवल Markdown फ़ाइलें इंडेक्स की जाती हैं।
- सिमलिंक्स अनदेखी की जाती हैं (फ़ाइलें या डाइरेक्टरीज़)।

### Gemini embeddings (native)

Gemini embeddings API को सीधे उपयोग करने के लिए प्रदाता को `gemini` पर सेट करें:

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

नोट्स:

- `remote.baseUrl` वैकल्पिक है (डिफ़ॉल्ट Gemini API बेस URL)।
- `remote.headers` आवश्यक होने पर अतिरिक्त हेडर्स जोड़ने देता है।
- डिफ़ॉल्ट मॉडल: `gemini-embedding-001`।

यदि आप **कस्टम OpenAI-संगत एंडपॉइंट** (OpenRouter, vLLM, या प्रॉक्सी) का उपयोग करना चाहते हैं,
तो OpenAI प्रदाता के साथ `remote` कॉन्फ़िगरेशन का उपयोग कर सकते हैं:

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

यदि आप API कुंजी सेट नहीं करना चाहते, तो `memorySearch.provider = "local"` का उपयोग करें या
`memorySearch.fallback = "none"` सेट करें।

फ़ॉलबैक्स:

- `memorySearch.fallback` `openai`, `gemini`, `local`, या `none` हो सकता है।
- फ़ॉलबैक प्रदाता केवल तब उपयोग होता है जब प्राथमिक एम्बेडिंग प्रदाता विफल हो।

Batch indexing (OpenAI + Gemini):

- OpenAI और Gemini एम्बेडिंग्स के लिए डिफ़ॉल्ट रूप से सक्षम। अक्षम करने के लिए `agents.defaults.memorySearch.remote.batch.enabled = false` सेट करें।
- डिफ़ॉल्ट व्यवहार बैच पूर्ण होने की प्रतीक्षा करता है; आवश्यकता होने पर `remote.batch.wait`, `remote.batch.pollIntervalMs`, और `remote.batch.timeoutMinutes` ट्यून करें।
- समानांतर में कितने बैच जॉब सबमिट हों, नियंत्रित करने के लिए `remote.batch.concurrency` सेट करें (डिफ़ॉल्ट: 2)।
- बैच मोड तब लागू होता है जब `memorySearch.provider = "openai"` या `"gemini"` हो और संबंधित API कुंजी का उपयोग करता है।
- Gemini बैच जॉब्स async embeddings batch endpoint का उपयोग करते हैं और Gemini Batch API उपलब्धता की आवश्यकता होती है।

Why OpenAI batch is fast + cheap:

- बड़े बैकफ़िल्स के लिए, OpenAI आमतौर पर सबसे तेज़ विकल्प होता है क्योंकि हम एक ही बैच जॉब में कई एम्बेडिंग अनुरोध सबमिट कर सकते हैं और OpenAI को उन्हें असिंक्रोनस रूप से प्रोसेस करने दे सकते हैं।
- OpenAI Batch API वर्कलोड्स के लिए रियायती मूल्य निर्धारण प्रदान करता है, इसलिए बड़े इंडेक्सिंग रन सामान्यतः वही अनुरोध सिंक्रोनस रूप से भेजने की तुलना में सस्ते होते हैं।
- विवरण के लिए OpenAI Batch API दस्तावेज़ और मूल्य निर्धारण देखें:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Config example:

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

Tools:

- `memory_search` — फ़ाइल + लाइन रेंज के साथ स्निपेट्स लौटाता है।
- `memory_get` — पाथ द्वारा मेमोरी फ़ाइल सामग्री पढ़ता है।

Local mode:

- `agents.defaults.memorySearch.provider = "local"` सेट करें।
- `agents.defaults.memorySearch.local.modelPath` प्रदान करें (GGUF या `hf:` URI)।
- वैकल्पिक: रिमोट फ़ॉलबैक से बचने के लिए `agents.defaults.memorySearch.fallback = "none"` सेट करें।

### How the memory tools work

- `memory_search` `MEMORY.md` + `memory/**/*.md` से Markdown चंक्स (~400 टोकन लक्ष्य, 80-टोकन ओवरलैप) को सिमेंटिक रूप से खोजता है। यह स्निपेट टेक्स्ट (लगभग ~700 अक्षरों तक सीमित), फ़ाइल पाथ, लाइन रेंज, स्कोर, प्रदाता/मॉडल, और यह कि हमने लोकल → रिमोट एम्बेडिंग्स पर फ़ॉलबैक किया या नहीं—लौटाता है। पूरा फ़ाइल पेलोड वापस नहीं किया जाता।
- `memory_get` किसी विशिष्ट मेमोरी Markdown फ़ाइल (वर्कस्पेस-रिलेटिव) को पढ़ता है, वैकल्पिक रूप से किसी प्रारंभिक लाइन से और N लाइनों के लिए। `MEMORY.md` / `memory/` के बाहर के पाथ्स अस्वीकार किए जाते हैं।
- दोनों टूल्स केवल तब सक्षम होते हैं जब एजेंट के लिए `memorySearch.enabled` true सुलझता है।

### What gets indexed (and when)

- फ़ाइल प्रकार: केवल Markdown (`MEMORY.md`, `memory/**/*.md`)।
- इंडेक्स स्टोरेज: प्रति-एजेंट SQLite `~/.openclaw/memory/<agentId>.sqlite` पर ( `agents.defaults.memorySearch.store.path` के माध्यम से कॉन्फ़िगर योग्य, `{agentId}` टोकन समर्थित)।
- ताज़गी: `MEMORY.md` + `memory/` पर वॉचर इंडेक्स को डर्टी मार्क करता है (डेबाउंस 1.5s)। 1. सिंक सत्र शुरू होने पर, खोज के समय, या किसी अंतराल पर निर्धारित किया जाता है और असिंक्रोनस रूप से चलता है। 2. सत्र ट्रांसक्रिप्ट बैकग्राउंड सिंक को ट्रिगर करने के लिए डेल्टा थ्रेशहोल्ड का उपयोग करते हैं।
- 3. री‑इंडेक्स ट्रिगर: इंडेक्स **provider/model + endpoint fingerprint + chunking params** को संग्रहीत करता है। 4. यदि इनमें से कोई भी बदलता है, तो OpenClaw स्वचालित रूप से पूरे स्टोर को रीसेट करता है और दोबारा इंडेक्स करता है।

### Hybrid search (BM25 + vector)

सक्षम होने पर, OpenClaw संयोजित करता है:

- **Vector similarity** (सेमांटिक मैच, शब्दावली अलग हो सकती है)
- **BM25 keyword relevance** (IDs, env vars, कोड सिंबल्स जैसे सटीक टोकन)

यदि आपके प्लेटफ़ॉर्म पर फुल-टेक्स्ट सर्च उपलब्ध नहीं है, तो OpenClaw वेक्टर-ओनली खोज पर फ़ॉलबैक करता है।

#### Why hybrid?

वेक्टर खोज “यह वही मतलब रखता है” में बेहतरीन है:

- “Mac Studio gateway host” बनाम “gateway चलाने वाली मशीन”
- “debounce file updates” बनाम “हर लिखावट पर इंडेक्सिंग से बचें”

लेकिन यह सटीक, उच्च-सिग्नल टोकन में कमजोर हो सकती है:

- IDs (`a828e60`, `b3b9895a…`)
- कोड सिंबल्स (`memorySearch.query.hybrid`)
- त्रुटि स्ट्रिंग्स (“sqlite-vec unavailable”)

BM25 (full-text) is the opposite: strong at exact tokens, weaker at paraphrases.
6. हाइब्रिड सर्च एक व्यावहारिक मध्य मार्ग है: **दोनों रिट्रीवल सिग्नल का उपयोग करें** ताकि
“natural language” क्वेरी और “needle in a haystack” क्वेरी—दोनों के लिए अच्छे परिणाम मिलें।

#### How we merge results (the current design)

Implementation sketch:

1. दोनों पक्षों से कैंडिडेट पूल प्राप्त करें:

- **Vector**: कोसाइन समानता द्वारा शीर्ष `maxResults * candidateMultiplier`।
- **BM25**: FTS5 BM25 रैंक द्वारा शीर्ष `maxResults * candidateMultiplier` (कम बेहतर)।

2. BM25 रैंक को 0..1-ish स्कोर में बदलें:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. चंक id द्वारा कैंडिडेट्स का यूनियन बनाएं और वेटेड स्कोर की गणना करें:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

नोट्स:

- `vectorWeight` + `textWeight` कॉन्फ़िग रेज़ोल्यूशन में 1.0 पर नॉर्मलाइज़ होता है, इसलिए वेट्स प्रतिशत की तरह व्यवहार करते हैं।
- यदि एम्बेडिंग्स अनुपलब्ध हैं (या प्रदाता शून्य-वेक्टर लौटाता है), तो हम फिर भी BM25 चलाते हैं और कीवर्ड मैच लौटाते हैं।
- यदि FTS5 बनाया नहीं जा सकता, तो हम वेक्टर-ओनली खोज रखते हैं (कोई हार्ड फ़ेल्योर नहीं)।

7. यह “IR‑theory perfect” नहीं है, लेकिन यह सरल, तेज़ है और वास्तविक नोट्स पर अक्सर रिकॉल/प्रिसिजन में सुधार करता है।
8. यदि हम बाद में और उन्नत करना चाहें, तो सामान्य अगले कदम Reciprocal Rank Fusion (RRF) या स्कोर नॉर्मलाइज़ेशन
   (min/max या z‑score) को मिक्स करने से पहले होते हैं।

Config:

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

### Embedding cache

OpenClaw SQLite में **चंक एम्बेडिंग्स** को कैश कर सकता है ताकि रीइंडेक्सिंग और बार-बार अपडेट्स (विशेषकर सत्र ट्रांसक्रिप्ट्स) अपरिवर्तित टेक्स्ट को दोबारा एम्बेड न करें।

Config:

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

### Session memory search (experimental)

9. आप वैकल्पिक रूप से **session transcripts** को इंडेक्स कर सकते हैं और उन्हें `memory_search` के माध्यम से दिखा सकते हैं।
10. यह एक experimental फ़्लैग के पीछे gated है।

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

नोट्स:

- सत्र इंडेक्सिंग **opt-in** है (डिफ़ॉल्ट रूप से बंद)।
- सत्र अपडेट्स debounced होते हैं और **असिंक्रोनस रूप से इंडेक्स** किए जाते हैं जब वे डेल्टा थ्रेशहोल्ड्स पार करते हैं (best-effort)।
- `memory_search` कभी भी इंडेक्सिंग पर ब्लॉक नहीं करता; बैकग्राउंड सिंक पूरा होने तक परिणाम थोड़े stale हो सकते हैं।
- परिणामों में अभी भी केवल स्निपेट्स शामिल होते हैं; `memory_get` मेमोरी फ़ाइलों तक सीमित रहता है।
- सत्र इंडेक्सिंग प्रति-एजेंट अलग-थलग होती है (केवल उसी एजेंट के सत्र लॉग्स इंडेक्स होते हैं)।
- 11. सत्र लॉग डिस्क पर रहते हैं (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)। 12. फ़ाइलसिस्टम एक्सेस वाला कोई भी प्रोसेस/यूज़र उन्हें पढ़ सकता है, इसलिए डिस्क एक्सेस को trust boundary मानें। For stricter isolation, run agents under separate OS users or hosts.

Delta thresholds (डिफ़ॉल्ट्स दिखाए गए):

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

### SQLite vector acceleration (sqlite-vec)

14. जब sqlite‑vec एक्सटेंशन उपलब्ध होता है, OpenClaw एम्बेडिंग्स को
    SQLite वर्चुअल टेबल (`vec0`) में स्टोर करता है और
    डेटाबेस में वेक्टर डिस्टेंस क्वेरी करता है। 15. इससे हर एम्बेडिंग को JS में लोड किए बिना सर्च तेज़ रहती है।

Configuration (optional):

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

नोट्स:

- `enabled` डिफ़ॉल्ट रूप से true है; अक्षम होने पर खोज स्टोर की गई एम्बेडिंग्स पर इन-प्रोसेस
  कोसाइन समानता पर फ़ॉलबैक करती है।
- यदि sqlite-vec एक्सटेंशन गायब है या लोड होने में विफल रहता है, OpenClaw त्रुटि लॉग करता है और
  JS फ़ॉलबैक के साथ जारी रहता है (कोई वेक्टर टेबल नहीं)।
- `extensionPath` बंडल्ड sqlite-vec पाथ को ओवरराइड करता है (कस्टम बिल्ड्स
  या गैर-मानक इंस्टॉल लोकेशन्स के लिए उपयोगी)।

### Local embedding auto-download

- डिफ़ॉल्ट लोकल एम्बेडिंग मॉडल: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 GB)।
- When `memorySearch.provider = "local"`, `node-llama-cpp` resolves `modelPath`; if the GGUF is missing it **auto-downloads** to the cache (or `local.modelCacheDir` if set), then loads it. 17. डाउनलोड्स रीट्राई पर रिज़्यूम हो जाते हैं।
- नेटिव बिल्ड आवश्यकता: `pnpm approve-builds` चलाएँ, `node-llama-cpp` चुनें, फिर `pnpm rebuild node-llama-cpp`।
- फ़ॉलबैक: यदि लोकल सेटअप विफल होता है और `memorySearch.fallback = "openai"`, तो हम स्वतः रिमोट एम्बेडिंग्स (`openai/text-embedding-3-small` जब तक ओवरराइड न हो) पर स्विच करते हैं और कारण रिकॉर्ड करते हैं।

### Custom OpenAI-compatible endpoint example

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

नोट्स:

- `remote.*` को `models.providers.openai.*` पर प्राथमिकता मिलती है।
- 18. `remote.headers` OpenAI हेडर्स के साथ मर्ज होते हैं; key conflict होने पर remote जीतता है। 19. OpenAI डिफ़ॉल्ट्स उपयोग करने के लिए `remote.headers` को छोड़ दें।
