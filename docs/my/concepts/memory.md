---
summary: "OpenClaw မေမိုရီ အလုပ်လုပ်ပုံ (workspace ဖိုင်များ + အလိုအလျောက် မေမိုရီ ရှင်းထုတ်ခြင်း)"
read_when:
  - မေမိုရီ ဖိုင်အလွှာအဆင့်နှင့် လုပ်ငန်းစဉ်ကို သိလိုသောအခါ
  - အလိုအလျောက် pre-compaction မေမိုရီ ရှင်းထုတ်ခြင်းကို ချိန်ညှိလိုသောအခါ
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:25Z
---

# Memory

OpenClaw မေမိုရီသည် **agent workspace အတွင်းရှိ ရိုးရိုး Markdown ဖိုင်များ** ဖြစ်သည်။ ဖိုင်များသည် အမှန်တရား၏ အရင်းအမြစ် ဖြစ်ပြီး မော်ဒယ်သည် ဒစ်စ်သို့ ရေးသားထားသော အရာများကိုသာ “မှတ်မိ” နိုင်သည်။

မေမိုရီ ရှာဖွေရေး ကိရိယာများကို လက်ရှိ အသက်ဝင်နေသော memory plugin (ပုံမှန်အားဖြင့်:
`memory-core`) က ပံ့ပိုးပေးသည်။ memory plugins များကို `plugins.slots.memory = "none"` ဖြင့် ပိတ်နိုင်သည်။

## Memory files (Markdown)

ပုံမှန် workspace အလွှာဖွဲ့စည်းပုံတွင် မေမိုရီ အလွှာ ၂ ခု အသုံးပြုသည် —

- `memory/YYYY-MM-DD.md`
  - နေ့စဉ် မှတ်တမ်း (append-only)။
  - ဆက်ရှင် စတင်ချိန်တွင် ယနေ့ + မနေ့ကို ဖတ်သည်။
- `MEMORY.md` (ရွေးချယ်နိုင်သည်)
  - ရွေးချယ်စီစဉ်ထားသော ရေရှည်မေမိုရီ။
  - **အဓိက၊ ကိုယ်ပိုင် ဆက်ရှင်တွင်သာ ဖတ်သည်** (အုပ်စု အခြေအနေများတွင် မဖတ်ပါ)။

ဤဖိုင်များသည် workspace (`agents.defaults.workspace`, ပုံမှန်
`~/.openclaw/workspace`) အောက်တွင် တည်ရှိသည်။ ဖွဲ့စည်းပုံ အပြည့်အစုံအတွက် [Agent workspace](/concepts/agent-workspace) ကို ကြည့်ပါ။

## Memory ကို ဘယ်အချိန် ရေးသင့်သလဲ

- ဆုံးဖြတ်ချက်များ၊ နှစ်သက်မှုများ၊ ရေရှည် အသုံးဝင်မည့် အချက်အလက်များကို `MEMORY.md` သို့ ရေးပါ။
- နေ့စဉ် မှတ်စုများနှင့် လက်ရှိ အလုပ်လုပ်နေသော အကြောင်းအရာများကို `memory/YYYY-MM-DD.md` သို့ ရေးပါ။
- တစ်ယောက်ယောက်က “ဒါကို မှတ်ထားပါ” ဟုပြောပါက RAM ထဲ မထားဘဲ ရေးချပါ။
- ဤအပိုင်းသည် ဆက်လက် ဖွံ့ဖြိုးနေဆဲ ဖြစ်သည်။ မော်ဒယ်ကို မေမိုရီ သိမ်းဆည်းရန် သတိပေးခြင်းက အထောက်အကူ ဖြစ်သည်။
- တစ်ခုခုကို တည်တံ့စေလိုပါက **bot ကို မေမိုရီထဲ ရေးပေးရန် တောင်းဆိုပါ**။

## Automatic memory flush (pre-compaction ping)

ဆက်ရှင်သည် **auto-compaction အနီးသို့ ရောက်လာသောအခါ** OpenClaw သည် **အသံမထွက်သော agentic turn** တစ်ခုကို အစပျိုးပြီး context ကို compact မလုပ်မီ **ရေရှည် မေမိုရီကို ရေးသားရန်** မော်ဒယ်ကို သတိပေးသည်။ ပုံမှန် prompt များတွင် မော်ဒယ်က _ပြန်ကြားနိုင်သည်_ ဟု ဖော်ပြထားသော်လည်း ပုံမှန်အားဖြင့် `NO_REPLY` သည် သင့်တော်သော တုံ့ပြန်မှု ဖြစ်သဖြင့် အသုံးပြုသူ မမြင်ရပါ။

ဤအပြုအမူကို `agents.defaults.compaction.memoryFlush` ဖြင့် ထိန်းချုပ်ထားသည် —

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

အသေးစိတ် —

- **Soft threshold**: ဆက်ရှင် token ခန့်မှန်းတန်ဖိုးသည်
  `contextWindow - reserveTokensFloor - softThresholdTokens` ကို ကျော်လွန်သည့်အခါ flush ကို အစပျိုးသည်။
- **ပုံမှန်အားဖြင့် အသံမထွက်**: prompt များတွင် `NO_REPLY` ပါဝင်သဖြင့် အသုံးပြုသူထံ မပို့ပါ။
- **Prompt ၂ ခု**: user prompt တစ်ခုနှင့် system prompt တစ်ခုတို့ ပူးပေါင်း၍ သတိပေးချက် ထည့်သွင်းသည်။
- **Compaction cycle တစ်ခါလျှင် flush တစ်ကြိမ်သာ** (`sessions.json` တွင် ခြေရာခံသည်)။
- **Workspace ကို ရေးနိုင်ရမည်**: ဆက်ရှင်ကို sandboxed ဖြင့်
  `workspaceAccess: "ro"` သို့မဟုတ် `"none"` ဖြင့် လည်ပတ်ပါက flush ကို ကျော်သွားသည်။

Compaction lifecycle အပြည့်အစုံအတွက်
[Session management + compaction](/reference/session-management-compaction) ကို ကြည့်ပါ။

## Vector memory search

OpenClaw သည် `MEMORY.md` နှင့် `memory/*.md` အပေါ်တွင် vector index သေးငယ်တစ်ခု တည်ဆောက်နိုင်ပြီး စကားလုံး အသုံးအနှုန်း မတူညီသော်လည်း ဆက်စပ် မှတ်စုများကို semantic query ဖြင့် ရှာတွေ့နိုင်စေသည်။

Defaults —

- ပုံမှန်အားဖြင့် ဖွင့်ထားသည်။
- မေမိုရီ ဖိုင် ပြောင်းလဲမှုများကို စောင့်ကြည့်သည် (debounced)။
- ပုံမှန်အားဖြင့် remote embeddings ကို အသုံးပြုသည်။ `memorySearch.provider` မသတ်မှတ်ထားပါက OpenClaw သည် အလိုအလျောက် ရွေးချယ်သည် —
  1. `local` ကို `memorySearch.local.modelPath` သတ်မှတ်ထားပြီး ဖိုင် ရှိပါက။
  2. OpenAI key ကို ဖြေရှင်းနိုင်ပါက `openai`။
  3. Gemini key ကို ဖြေရှင်းနိုင်ပါက `gemini`။
  4. Voyage key ကို ဖြေရှင်းနိုင်ပါက `voyage`။
  5. မဟုတ်ပါက စီစဉ်ချိန်ညှိမချင်း memory search ကို ပိတ်ထားမည်။
- Local mode သည် node-llama-cpp ကို အသုံးပြုပြီး `pnpm approve-builds` လိုအပ်နိုင်သည်။
- SQLite အတွင်း vector search ကို မြန်ဆန်စေရန် sqlite-vec (ရရှိနိုင်ပါက) ကို အသုံးပြုသည်။

Remote embeddings များအတွက် embedding provider ၏ API key **မဖြစ်မနေ လိုအပ်** သည်။ OpenClaw သည် auth profiles၊ `models.providers.*.apiKey` သို့မဟုတ် environment
variables မှ key များကို ဖြေရှင်းသည်။ Codex OAuth သည် chat/completions ကိုသာ ဖုံးလွှမ်းပြီး memory search အတွက် embeddings ကို **မဖြည့်ဆည်းနိုင်ပါ**။ Gemini အတွက် `GEMINI_API_KEY` သို့မဟုတ်
`models.providers.google.apiKey` ကို အသုံးပြုပါ။ Voyage အတွက် `VOYAGE_API_KEY` သို့မဟုတ်
`models.providers.voyage.apiKey` ကို အသုံးပြုပါ။ custom OpenAI-compatible endpoint ကို အသုံးပြုပါက
`memorySearch.remote.apiKey` (နှင့် ရွေးချယ်နိုင်သော `memorySearch.remote.headers`) ကို သတ်မှတ်ပါ။

### QMD backend (experimental)

Built-in SQLite indexer အစား
[QMD](https://github.com/tobi/qmd) ကို အသုံးပြုလိုပါက `memory.backend = "qmd"` ကို သတ်မှတ်ပါ။ QMD သည် BM25 + vectors + reranking ကို ပေါင်းစပ်ထားသော local-first search sidecar ဖြစ်သည်။ Markdown သည် အမှန်တရား၏ အရင်းအမြစ်အဖြစ် ဆက်လက်ရှိနေပြီး OpenClaw သည် retrieval အတွက် QMD ကို shell ဖြင့် ခေါ်ယူသည်။ အချက်အလက်များ —

**Prereqs**

- ပုံမှန်အားဖြင့် ပိတ်ထားသည်။ config တစ်ခုချင်းစီအလိုက် `memory.backend = "qmd"` ဖြင့် ဖွင့်ပါ။
- QMD CLI ကို သီးခြား ထည့်သွင်းရမည် (`bun install -g https://github.com/tobi/qmd` သို့မဟုတ်
  release ကို ရယူပါ) နှင့် `qmd` binary သည် gateway ၏ `PATH` ပေါ်တွင် ရှိရမည်။
- QMD သည် extension များ ခွင့်ပြုထားသော SQLite build လိုအပ်သည် (`brew install sqlite` on
  macOS)။
- QMD သည် Bun + `node-llama-cpp` ဖြင့် local အပြည့်အဝ လည်ပတ်ပြီး ပထမဆုံး အသုံးပြုချိန်တွင် HuggingFace မှ GGUF
  models များကို အလိုအလျောက် ဒေါင်းလုပ်လုပ်သည် (သီးခြား Ollama daemon မလိုအပ်ပါ)။
- Gateway သည် QMD ကို self-contained XDG home အဖြစ်
  `~/.openclaw/agents/<agentId>/qmd/` အောက်တွင် `XDG_CONFIG_HOME` နှင့်
  `XDG_CACHE_HOME` သတ်မှတ်၍ လည်ပတ်စေသည်။
- OS အထောက်အပံ့: macOS နှင့် Linux သည် Bun + SQLite ထည့်သွင်းပြီးပါက အဆင်ပြေစွာ အလုပ်လုပ်သည်။ Windows အတွက် WSL2 ဖြင့် အကောင်းဆုံး ပံ့ပိုးထားသည်။

**Sidecar အလုပ်လုပ်ပုံ**

- Gateway သည် self-contained QMD home ကို
  `~/.openclaw/agents/<agentId>/qmd/` အောက်တွင် ရေးသားသည် (config + cache + sqlite DB)။
- Collections များကို `memory.qmd.paths` မှ `qmd collection add` ဖြင့် ဖန်တီးပြီး
  (workspace မေမိုရီ ဖိုင်များကိုပါ ပေါင်းထည့်သည်) ထို့နောက် `qmd update` + `qmd embed` ကို
  boot အချိန်နှင့် သတ်မှတ်နိုင်သော အချိန်အInterval (`memory.qmd.update.interval`,
  ပုံမှန် 5 မိနစ်) တွင် လည်ပတ်စေသည်။
- Boot refresh ကို ယခု ပုံမှန်အားဖြင့် background တွင် လည်ပတ်စေသဖြင့် chat စတင်မှု မပိတ်ဆို့တော့ပါ။ ယခင်
  blocking အပြုအမူကို ဆက်ထားလိုပါက `memory.qmd.update.waitForBootSync = true` ကို သတ်မှတ်ပါ။
- Search များကို `qmd query --json` ဖြင့် လည်ပတ်သည်။ QMD မအောင်မြင်ပါက သို့မဟုတ် binary မရှိပါက
  OpenClaw သည် builtin SQLite manager သို့ အလိုအလျောက် ပြန်လည်ပြောင်းပြီး memory tools များ ဆက်လက် အလုပ်လုပ်စေသည်။
- OpenClaw သည် ယနေ့အချိန်တွင် QMD embed batch-size tuning ကို မဖော်ပြပါ။ batch အပြုအမူကို
  QMD ကိုယ်တိုင် ထိန်းချုပ်သည်။
- **ပထမဆုံး search သည် နှေးကွေးနိုင်သည်**: ပထမဆုံး `qmd query` လည်ပတ်ချိန်တွင် QMD သည် local GGUF models (reranker/query
  expansion) များကို ဒေါင်းလုပ်လုပ်နိုင်သည်။
  - OpenClaw သည် QMD လည်ပတ်ချိန်တွင် `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` ကို အလိုအလျောက် သတ်မှတ်ပေးသည်။
  - Model များကို ကိုယ်တိုင် ကြိုတင် ဒေါင်းလုပ်လုပ်ပြီး (OpenClaw အသုံးပြုသည့် index ကို အပူပေးလိုပါက)
    agent ၏ XDG dirs ဖြင့် one-off query တစ်ခုကို လည်ပတ်ပါ။

    OpenClaw ၏ QMD state သည် သင့် **state dir** အောက်တွင် ရှိသည် (ပုံမှန် `~/.openclaw`)။
    OpenClaw အသုံးပြုသည့် XDG vars တူညီစေရန် export လုပ်ခြင်းဖြင့်
    `qmd` ကို အတူတူ index သို့ ညွှန်ပြနိုင်သည် —

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

- `command` (ပုံမှန် `qmd`): executable path ကို override လုပ်သည်။
- `includeDefaultMemory` (ပုံမှန် `true`): `MEMORY.md` + `memory/**/*.md` ကို auto-index လုပ်သည်။
- `paths[]`: ထပ်မံ directory/file များ ထည့်ရန် (`path`, ရွေးချယ်နိုင်သော `pattern`, တည်ငြိမ်သော
  `name` ကို ရွေးချယ်နိုင်သည်)။
- `sessions`: session JSONL indexing ကို ဖွင့်ရန် (`enabled`, `retentionDays`,
  `exportDir`)။
- `update`: refresh cadence နှင့် maintenance လည်ပတ်မှုကို ထိန်းချုပ်သည် —
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`)။
- `limits`: recall payload ကို clamp လုပ်သည် (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`)။
- `scope`: [`session.sendPolicy`](/gateway/configuration#session) နှင့် schema တူညီသည်။
  ပုံမှန်အားဖြင့် DM-only (`deny` အားလုံး၊ `allow` direct chats) ဖြစ်ပြီး
  အုပ်စု/ချန်နယ်များတွင် QMD hits များ ပေါ်လာစေရန် loosen လုပ်နိုင်သည်။
- Workspace ပြင်ပမှ ရင်းမြစ်ယူသော snippet များသည်
  `memory_search` ရလဒ်များတွင် `qmd/<collection>/<relative-path>` အဖြစ် ပေါ်လာသည်။ `memory_get` သည် ထို prefix ကို နားလည်ပြီး
  သတ်မှတ်ထားသော QMD collection root မှ ဖတ်သည်။
- `memory.qmd.sessions.enabled = true` ဖြစ်ပါက OpenClaw သည် သန့်စင်ထားသော session
  transcript များ (User/Assistant turns) ကို `~/.openclaw/agents/<id>/qmd/sessions/` အောက်ရှိ သီးသန့် QMD collection သို့ export လုပ်ပြီး
  builtin SQLite index ကို မထိဘဲ `memory_search` မှ မကြာသေးသော စကားဝိုင်းများကို ပြန်ခေါ်နိုင်စေသည်။
- `memory_search` snippet များတွင် `Source: <path#line>` footer ကို ယခု
  `memory.citations` သည် `auto`/`on` ဖြစ်သည့်အခါ ပါဝင်လာသည်။ Path metadata ကို အတွင်းပိုင်းတွင်သာ ထားလိုပါက
  `memory.citations = "off"` ကို သတ်မှတ်ပါ (agent သည် `memory_get` အတွက် path ကို ဆက်လက် ရရှိသော်လည်း
  snippet စာသားတွင် footer မပါဝင်တော့ပါ၊ system prompt ကလည်း မ引用ရန် သတိပေးပါသည်)။

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

- Backend မည်သို့ဖြစ်စေ `memory.citations` သက်ဆိုင်သည် (`auto`/`on`/`off`)။
- `qmd` လည်ပတ်သည့်အခါ ရလဒ်များကို ဘယ် engine က ပံ့ပိုးခဲ့သည်ကို diagnostics တွင် ပြသနိုင်ရန်
  `status().backend = "qmd"` ကို tag လုပ်သည်။ QMD subprocess ထွက်သွားပါက သို့မဟုတ် JSON output ကို parse မလုပ်နိုင်ပါက
  search manager သည် သတိပေးချက် မှတ်တမ်းတင်ပြီး builtin provider
  (ရှိပြီးသား Markdown embeddings) ကို ပြန်ပေးသည်။

### Additional memory paths

ပုံမှန် workspace ဖွဲ့စည်းပုံ အပြင်ဘက်ရှိ Markdown ဖိုင်များကို index လုပ်လိုပါက
လမ်းကြောင်းများကို ထည့်ပါ —

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

မှတ်ချက်များ —

- လမ်းကြောင်းများသည် absolute သို့မဟုတ် workspace-relative ဖြစ်နိုင်သည်။
- Directory များကို `.md` ဖိုင်များအတွက် recursive စစ်ဆေးသည်။
- Markdown ဖိုင်များကိုသာ index လုပ်သည်။
- Symlink များကို (ဖိုင် သို့မဟုတ် directory) လျစ်လျူရှုသည်။

### Gemini embeddings (native)

Gemini embeddings API ကို တိုက်ရိုက် အသုံးပြုရန် provider ကို `gemini` သို့ သတ်မှတ်ပါ —

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

မှတ်ချက်များ —

- `remote.baseUrl` သည် ရွေးချယ်နိုင်သည် (ပုံမှန်အားဖြင့် Gemini API base URL)။
- `remote.headers` ဖြင့် လိုအပ်ပါက header များ ထပ်ထည့်နိုင်သည်။
- ပုံမှန် မော်ဒယ်: `gemini-embedding-001`။

**custom OpenAI-compatible endpoint** (OpenRouter, vLLM, သို့မဟုတ် proxy) ကို အသုံးပြုလိုပါက
OpenAI provider နှင့်အတူ `remote` configuration ကို အသုံးပြုနိုင်သည် —

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

API key မသတ်မှတ်လိုပါက `memorySearch.provider = "local"` ကို အသုံးပြုပါ သို့မဟုတ်
`memorySearch.fallback = "none"` ကို သတ်မှတ်ပါ။

Fallbacks —

- `memorySearch.fallback` သည် `openai`, `gemini`, `local`, သို့မဟုတ် `none` ဖြစ်နိုင်သည်။
- Fallback provider ကို primary embedding provider မအောင်မြင်သည့်အခါတွင်သာ အသုံးပြုသည်။

Batch indexing (OpenAI + Gemini) —

- OpenAI နှင့် Gemini embeddings အတွက် ပုံမှန်အားဖြင့် ဖွင့်ထားသည်။ ပိတ်လိုပါက `agents.defaults.memorySearch.remote.batch.enabled = false` ကို သတ်မှတ်ပါ။
- ပုံမှန် အပြုအမူသည် batch ပြီးဆုံးသည်အထိ စောင့်သည်။ လိုအပ်ပါက `remote.batch.wait`, `remote.batch.pollIntervalMs`, နှင့် `remote.batch.timeoutMinutes` ကို ချိန်ညှိပါ။
- အပြိုင် submit လုပ်မည့် batch jobs အရေအတွက်ကို ထိန်းချုပ်ရန် `remote.batch.concurrency` ကို သတ်မှတ်ပါ (ပုံမှန်: 2)။
- Batch mode သည် `memorySearch.provider = "openai"` သို့မဟုတ် `"gemini"` ဖြစ်သည့်အခါ အသုံးပြုကာ သက်ဆိုင်ရာ API key ကို အသုံးပြုသည်။
- Gemini batch jobs များသည် async embeddings batch endpoint ကို အသုံးပြုပြီး Gemini Batch API ရရှိနိုင်ရမည်။

Why OpenAI batch is fast + cheap —

- အကြီးစား backfill များအတွက် OpenAI သည် batch job တစ်ခုအတွင်း embedding request များစွာကို submit လုပ်နိုင်ပြီး
  asynchronous အနေဖြင့် ဆောင်ရွက်ပေးသဖြင့် ပုံမှန်အားဖြင့် အမြန်ဆုံး ဖြစ်သည်။
- OpenAI သည် Batch API workload များအတွက် လျှော့စျေး ပေးသဖြင့်
  synchronous ပို့ပေးခြင်းထက် စျေးသက်သာလေ့ရှိသည်။
- အသေးစိတ်အတွက် OpenAI Batch API docs နှင့် pricing ကို ကြည့်ပါ —
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Config example —

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

Tools —

- `memory_search` — ဖိုင် + လိုင်းအကွာအဝေး ပါဝင်သည့် snippet များကို ပြန်ပေးသည်။
- `memory_get` — path ဖြင့် မေမိုရီ ဖိုင် အကြောင်းအရာကို ဖတ်သည်။

Local mode —

- `agents.defaults.memorySearch.provider = "local"` ကို သတ်မှတ်ပါ။
- `agents.defaults.memorySearch.local.modelPath` (GGUF သို့မဟုတ် `hf:` URI) ကို ပေးပါ။
- ရွေးချယ်နိုင်သည်: remote fallback ကို ရှောင်ရန် `agents.defaults.memorySearch.fallback = "none"` ကို သတ်မှတ်ပါ။

### How the memory tools work

- `memory_search` သည် `MEMORY.md` + `memory/**/*.md` မှ Markdown chunk များကို semantic search လုပ်သည်
  (~400 token target, 80-token overlap)။ snippet စာသား (~700 chars ကန့်သတ်),
  ဖိုင်လမ်းကြောင်း၊ လိုင်းအကွာအဝေး၊ score၊ provider/model နှင့် local → remote embeddings သို့ fallback ဖြစ်ခဲ့မဖြစ်ခဲ့ကို ပြန်ပေးသည်။
  ဖိုင်အပြည့်အစုံကို မပြန်ပေးပါ။
- `memory_get` သည် သတ်မှတ်ထားသော memory Markdown ဖိုင်ကို (workspace-relative) ဖတ်ပြီး
  စတင်လိုင်းမှ သို့မဟုတ် N လိုင်းအထိ ဖတ်နိုင်သည်။ `MEMORY.md` / `memory/` အပြင်ဘက် လမ်းကြောင်းများကို ပယ်ချသည်။
- ကိရိယာ ၂ ခုစလုံးသည် agent အတွက် `memorySearch.enabled` true ဖြစ်မှသာ ဖွင့်ထားသည်။

### What gets indexed (and when)

- ဖိုင်အမျိုးအစား: Markdown သာ (`MEMORY.md`, `memory/**/*.md`)။
- Index သိမ်းဆည်းရာ: per-agent SQLite ကို `~/.openclaw/memory/<agentId>.sqlite` တွင် သိမ်းဆည်းသည် (`agents.defaults.memorySearch.store.path` ဖြင့် ချိန်ညှိနိုင်ပြီး `{agentId}` token ကို ထောက်ပံ့သည်)။
- Freshness: `MEMORY.md` + `memory/` အပေါ် watcher တစ်ခုက index ကို dirty အဖြစ် မှတ်သားသည် (debounce 1.5s)။
  Sync ကို ဆက်ရှင် စတင်ချိန်၊ search လုပ်ချိန်၊ သို့မဟုတ် interval တစ်ခုအလိုက် အစီအစဉ်ချပြီး asynchronous လည်ပတ်သည်။
  Session transcript များသည် delta threshold များကို အသုံးပြုပြီး background sync ကို အစပျိုးသည်။
- Reindex triggers: index သည် embedding **provider/model + endpoint fingerprint + chunking params** ကို သိမ်းထားသည်။
  ထိုအရာများ ပြောင်းလဲပါက OpenClaw သည် store အားလုံးကို အလိုအလျောက် reset လုပ်ပြီး ပြန်လည် index လုပ်သည်။

### Hybrid search (BM25 + vector)

ဖွင့်ထားပါက OpenClaw သည် —

- **Vector similarity** (semantic ကိုက်ညီမှု၊ စကားလုံး မတူနိုင်)
- **BM25 keyword relevance** (ID များ၊ env vars၊ code symbols ကဲ့သို့ တိကျသော token များ)

တို့ကို ပေါင်းစပ် အသုံးပြုသည်။

Platform ပေါ်တွင် full-text search မရရှိနိုင်ပါက OpenClaw သည် vector-only search သို့ fallback လုပ်သည်။

#### Why hybrid?

Vector search သည် “အဓိပ္ပါယ် တူသည်” ကို ကောင်းစွာ ရှာနိုင်သည် —

- “Mac Studio gateway host” နှင့် “gateway ကို လည်ပတ်နေသော စက်”
- “debounce file updates” နှင့် “ရေးတိုင်း index မလုပ်ရန်”

သို့သော် တိကျပြီး signal မြင့်သော token များအတွက်တော့ အားနည်းနိုင်သည် —

- IDs (`a828e60`, `b3b9895a…`)
- code symbols (`memorySearch.query.hybrid`)
- error strings (“sqlite-vec unavailable”)

BM25 (full-text) သည် အပြန်အလှန်အားဖြင့် တိကျသော token များတွင် အားကောင်းပြီး paraphrase များတွင် အားနည်းသည်။
Hybrid search သည် လက်တွေ့ကျသော အလယ်အလတ်ဖြစ်ပြီး **retrieval signal နှစ်မျိုးလုံးကို အသုံးပြုခြင်း** ဖြင့်
“သဘာဝဘာသာစကား” query များနှင့် “မြက်တောထဲက အပ်ရှာခြင်း” query များ နှစ်မျိုးစလုံးတွင် ရလဒ်ကောင်းများ ရရှိစေသည်။

#### How we merge results (the current design)

Implementation အကျဉ်းချုပ် —

1. နှစ်ဘက်စလုံးမှ candidate pool ကို ရယူသည် —

- **Vector**: cosine similarity အရ ထိပ်ဆုံး `maxResults * candidateMultiplier`။
- **BM25**: FTS5 BM25 rank အရ ထိပ်ဆုံး `maxResults * candidateMultiplier` (နည်းလေလေ ပိုကောင်း)။

2. BM25 rank ကို 0..1 ခန့်မှန်း score အဖြစ် ပြောင်းသည် —

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. chunk id ဖြင့် candidates များကို ပေါင်းပြီး weighted score ကို တွက်ချက်သည် —

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

မှတ်ချက်များ —

- `vectorWeight` + `textWeight` ကို config ဖြေရှင်းချိန်တွင် 1.0 သို့ normalize လုပ်ထားသဖြင့် weight များသည် ရာခိုင်နှုန်းကဲ့သို့ အလုပ်လုပ်သည်။
- Embeddings မရရှိနိုင်ပါက (သို့မဟုတ် provider က zero-vector ပြန်ပေးပါက) BM25 ကို ဆက်လက် လည်ပတ်ပြီး keyword match များကို ပြန်ပေးသည်။
- FTS5 မဖန်တီးနိုင်ပါက vector-only search ကို ဆက်ထားသည် (hard failure မလုပ်ပါ)။

ဤဒီဇိုင်းသည် “IR-theory အပြည့်အစုံ” မဟုတ်သော်လည်း ရိုးရှင်း၊ မြန်ဆန်ပြီး လက်တွေ့ မှတ်စုများတွင် recall/precision ကို တိုးတက်စေတတ်သည်။
နောက်ထပ် အဆင့်မြင့်လိုပါက Reciprocal Rank Fusion (RRF) သို့မဟုတ် score normalization
(min/max သို့မဟုတ် z-score) ကို ပေါင်းစပ်နိုင်သည်။

Config —

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

OpenClaw သည် **chunk embedding များကို SQLite တွင် cache လုပ်** နိုင်ပြီး
reindexing နှင့် မကြာခဏ update များ (အထူးသဖြင့် session transcript များ) တွင်
မပြောင်းလဲသော စာသားကို ပြန်လည် embed မလုပ်စေရန် ကူညီသည်။

Config —

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

**session transcript များကို index လုပ်** ပြီး `memory_search` ဖြင့် ပြသနိုင်သည်။
ဤအရာသည် experimental flag အောက်တွင်သာ ရှိသည်။

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

မှတ်ချက်များ —

- Session indexing သည် **opt-in** ဖြစ်သည် (ပုံမှန် ပိတ်ထားသည်)။
- Session update များကို debounce လုပ်ပြီး delta threshold များ ကျော်လွန်သည့်အခါ **asynchronous အဖြစ် index လုပ်** သည် (best-effort)။
- `memory_search` သည် indexing ကို မပိတ်ဆို့ပါ။ background sync ပြီးဆုံးသည်အထိ ရလဒ်များ အနည်းငယ် မလတ်ဆတ်နိုင်ပါ။
- ရလဒ်များတွင် snippet များသာ ပါဝင်ပြီး `memory_get` သည် မေမိုရီ ဖိုင်များအတွက်သာ ဆက်လက် ကန့်သတ်ထားသည်။
- Session indexing သည် agent တစ်ခုချင်းစီအလိုက် ခွဲထားသည် (အဆိုပါ agent ၏ session log များကိုသာ index လုပ်သည်)။
- Session log များသည် ဒစ်စ်ပေါ်တွင် တည်ရှိသည် (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)။ filesystem access ရှိသူ မည်သူမဆို ဖတ်နိုင်သဖြင့်
  disk access ကို trust boundary အဖြစ် သတ်မှတ်စဉ်းစားပါ။ ပိုမို တင်းကျပ်လိုပါက agent များကို OS user သို့မဟုတ် host ခွဲ၍ လည်ပတ်ပါ။

Delta thresholds (ပုံမှန်တန်ဖိုးများ) —

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

sqlite-vec extension ရရှိနိုင်ပါက OpenClaw သည် embedding များကို
SQLite virtual table (`vec0`) တွင် သိမ်းဆည်းပြီး
database အတွင်းတွင် vector distance query များကို ဆောင်ရွက်သည်။
ဤနည်းလမ်းသည် embedding အားလုံးကို JS ထဲ မတင်ဘဲ search ကို မြန်ဆန်စေသည်။

Configuration (ရွေးချယ်နိုင်သည်) —

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

မှတ်ချက်များ —

- `enabled` သည် ပုံမှန် true ဖြစ်သည်။ ပိတ်ထားပါက
  သိမ်းဆည်းထားသော embedding များအပေါ် in-process cosine similarity သို့ fallback လုပ်သည်။
- sqlite-vec extension မရှိပါက သို့မဟုတ် load မလုပ်နိုင်ပါက OpenClaw သည်
  error ကို မှတ်တမ်းတင်ပြီး JS fallback ဖြင့် ဆက်လက် လည်ပတ်သည် (vector table မရှိပါ)။
- `extensionPath` သည် bundled sqlite-vec path ကို override လုပ်သည် (custom build များ သို့မဟုတ်
  non-standard install location များတွင် အသုံးဝင်သည်)။

### Local embedding auto-download

- ပုံမှန် local embedding မော်ဒယ်: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 GB)။
- `memorySearch.provider = "local"` ဖြစ်ပါက `node-llama-cpp` သည် `modelPath` ကို ဖြေရှင်းပြီး
  GGUF မရှိပါက cache (သို့မဟုတ် `local.modelCacheDir` သတ်မှတ်ထားပါက ထိုနေရာ) သို့ **အလိုအလျောက် ဒေါင်းလုပ်လုပ်** ကာ load လုပ်သည်။
  Retry လုပ်ပါက download ဆက်လက် ပြန်စတင်သည်။
- Native build လိုအပ်ချက်: `pnpm approve-builds` ကို run လုပ်ပြီး `node-llama-cpp` ကို ရွေးကာ
  ထို့နောက် `pnpm rebuild node-llama-cpp` ကို လုပ်ပါ။
- Fallback: local setup မအောင်မြင်ပါက နှင့် `memorySearch.fallback = "openai"` ဖြစ်ပါက
  OpenClaw သည် remote embeddings (`openai/text-embedding-3-small` ကို မ override လုပ်ထားပါက) သို့ အလိုအလျောက် ပြောင်းပြီး အကြောင်းရင်းကို မှတ်တမ်းတင်သည်။

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

မှတ်ချက်များ —

- `remote.*` သည် `models.providers.openai.*` ထက် ဦးစားပေးသည်။
- `remote.headers` သည် OpenAI headers များနှင့် merge လုပ်သည်။ key များ ပဋိပက္ခဖြစ်ပါက remote က အနိုင်ရသည်။
  OpenAI defaults ကို အသုံးပြုလိုပါက `remote.headers` ကို ချန်ထားပါ။
