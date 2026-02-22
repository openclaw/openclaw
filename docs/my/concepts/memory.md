---
summary: "OpenClaw မေမိုရီ အလုပ်လုပ်ပုံ (workspace ဖိုင်များ + အလိုအလျောက် မေမိုရီ ရှင်းထုတ်ခြင်း)"
read_when:
  - မေမိုရီ ဖိုင်အလွှာအဆင့်နှင့် လုပ်ငန်းစဉ်ကို သိလိုသောအခါ
  - အလိုအလျောက် pre-compaction မေမိုရီ ရှင်းထုတ်ခြင်းကို ချိန်ညှိလိုသောအခါ
---

# Memory

31. OpenClaw memory သည် **agent workspace ထဲရှိ plain Markdown** ဖြစ်ပါသည်။ 32. File များသည် source of truth ဖြစ်ပြီး၊ model သည် disk သို့ ရေးသားထားသော အရာများကိုသာ “မှတ်မိ” ပါသည်။

32. Memory search tools များကို active memory plugin (default: `memory-core`) မှ ပံ့ပိုးပေးပါသည်။ 34. Memory plugins များကို `plugins.slots.memory = "none"` ဖြင့် ပိတ်နိုင်ပါသည်။

## Memory files (Markdown)

ပုံမှန် workspace အလွှာဖွဲ့စည်းပုံတွင် မေမိုရီ အလွှာ ၂ ခု အသုံးပြုသည် —

- `memory/YYYY-MM-DD.md`
  - နေ့စဉ် မှတ်တမ်း (append-only)။
  - ဆက်ရှင် စတင်ချိန်တွင် ယနေ့ + မနေ့ကို ဖတ်သည်။
- `MEMORY.md` (ရွေးချယ်နိုင်သည်)
  - ရွေးချယ်စီစဉ်ထားသော ရေရှည်မေမိုရီ။
  - **အဓိက၊ ကိုယ်ပိုင် ဆက်ရှင်တွင်သာ ဖတ်သည်** (အုပ်စု အခြေအနေများတွင် မဖတ်ပါ)။

35. ဤ file များသည် workspace (`agents.defaults.workspace`, default `~/.openclaw/workspace`) အောက်တွင် ရှိပါသည်။ 36. Layout အပြည့်အစုံအတွက် [Agent workspace](/concepts/agent-workspace) ကို ကြည့်ပါ။

## Memory ကို ဘယ်အချိန် ရေးသင့်သလဲ

- ဆုံးဖြတ်ချက်များ၊ နှစ်သက်မှုများ၊ ရေရှည် အသုံးဝင်မည့် အချက်အလက်များကို `MEMORY.md` သို့ ရေးပါ။
- နေ့စဉ် မှတ်စုများနှင့် လက်ရှိ အလုပ်လုပ်နေသော အကြောင်းအရာများကို `memory/YYYY-MM-DD.md` သို့ ရေးပါ။
- တစ်ယောက်ယောက်က “ဒါကို မှတ်ထားပါ” ဟုပြောပါက RAM ထဲ မထားဘဲ ရေးချပါ။
- 37. ဤဧရိယာသည် ဆက်လက် ဖွံ့ဖြိုးနေဆဲ ဖြစ်ပါသည်။ 38. Model ကို memory များ သိမ်းဆည်းရန် သတိပေးခြင်းက အထောက်အကူဖြစ်ပြီး၊ ၎င်းသည် ဘာလုပ်ရမည်ကို သိပါသည်။
- တစ်ခုခုကို တည်တံ့စေလိုပါက **bot ကို မေမိုရီထဲ ရေးပေးရန် တောင်းဆိုပါ**။

## Automatic memory flush (pre-compaction ping)

39. Session သည် **auto-compaction နီးကပ်လာသောအခါ** OpenClaw သည် **silent, agentic turn** ကို trigger လုပ်ပြီး context ကို compact မလုပ်မီ durable memory ကို ရေးသားရန် model ကို သတိပေးပါသည်။ 40. Default prompts များတွင် model သည် _reply လုပ်နိုင်သည်_ ဟု ပြောထားသော်လည်း၊ အသုံးများသောအခါ `NO_REPLY` သည် မှန်ကန်သော တုံ့ပြန်မှုဖြစ်ပြီး user သည် ဤ turn ကို မမြင်ရပါ။

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
- 41. Default အနေဖြင့် remote embeddings ကို အသုံးပြုပါသည်။ 42. `memorySearch.provider` ကို မသတ်မှတ်ထားပါက OpenClaw သည် auto-select လုပ်ပါသည်။
  1. `local` ကို `memorySearch.local.modelPath` သတ်မှတ်ထားပြီး ဖိုင် ရှိပါက။
  1. OpenAI key ကို ဖြေရှင်းနိုင်ပါက `openai`။
  1. Gemini key ကို ဖြေရှင်းနိုင်ပါက `gemini`။
  1. Voyage key ကို ဖြေရှင်းနိုင်ပါက `voyage`။
  1. မဟုတ်ပါက စီစဉ်ချိန်ညှိမချင်း memory search ကို ပိတ်ထားမည်။
- Local mode သည် node-llama-cpp ကို အသုံးပြုပြီး `pnpm approve-builds` လိုအပ်နိုင်သည်။
- SQLite အတွင်း vector search ကို မြန်ဆန်စေရန် sqlite-vec (ရရှိနိုင်ပါက) ကို အသုံးပြုသည်။

43. Remote embeddings များသည် embedding provider အတွက် API key ကို **လိုအပ်ပါသည်**။ 44. OpenClaw သည် auth profiles, `models.providers.*.apiKey`, သို့မဟုတ် environment variables များမှ key များကို resolve လုပ်ပါသည်။ 45. Codex OAuth သည် chat/completions ကိုသာ ဖုံးလွှမ်းပြီး memory search အတွက် embeddings ကို **မဖြည့်ဆည်းနိုင်ပါ**။ 46. Gemini အတွက် `GEMINI_API_KEY` သို့မဟုတ် `models.providers.google.apiKey` ကို အသုံးပြုပါ။ 47. Voyage အတွက် `VOYAGE_API_KEY` သို့မဟုတ် `models.providers.voyage.apiKey` ကို အသုံးပြုပါ။ 48. Custom OpenAI-compatible endpoint ကို အသုံးပြုပါက `memorySearch.remote.apiKey` (နှင့် optional `memorySearch.remote.headers`) ကို သတ်မှတ်ပါ။

### QMD backend (experimental)

49. Built-in SQLite indexer ကို [QMD](https://github.com/tobi/qmd) ဖြင့် ပြောင်းလဲရန် `memory.backend = "qmd"` ကို သတ်မှတ်ပါ။ QMD သည် BM25 + vectors + reranking ကို ပေါင်းစပ်ထားသော local-first search sidecar ဖြစ်ပါသည်။ 50. Markdown သည် source of truth အဖြစ် ဆက်လက် ရှိနေပြီး၊ OpenClaw သည် retrieval အတွက် QMD ကို shell out လုပ်ပါသည်။ ၁။ အဓိကအချက်များ:

**Prereqs**

- ၂။ မူလအနေဖြင့် ပိတ်ထားသည်။ ၃။ config တစ်ခုချင်းစီအလိုက် opt in လုပ်ရန် (`memory.backend = "qmd"`)။
- QMD CLI ကို သီးခြား ထည့်သွင်းရမည် (`bun install -g https://github.com/tobi/qmd` သို့မဟုတ်
  release ကို ရယူပါ) နှင့် `qmd` binary သည် gateway ၏ `PATH` ပေါ်တွင် ရှိရမည်။
- QMD သည် extension များ ခွင့်ပြုထားသော SQLite build လိုအပ်သည် (`brew install sqlite` on
  macOS)။
- QMD သည် Bun + `node-llama-cpp` ဖြင့် local အပြည့်အဝ လည်ပတ်ပြီး ပထမဆုံး အသုံးပြုချိန်တွင် HuggingFace မှ GGUF
  models များကို အလိုအလျောက် ဒေါင်းလုပ်လုပ်သည် (သီးခြား Ollama daemon မလိုအပ်ပါ)။
- Gateway သည် QMD ကို self-contained XDG home အဖြစ်
  `~/.openclaw/agents/<agentId>/qmd/` အောက်တွင် `XDG_CONFIG_HOME` နှင့်
  `XDG_CACHE_HOME` သတ်မှတ်၍ လည်ပတ်စေသည်။
- ၄။ OS ပံ့ပိုးမှု: Bun + SQLite ကို ထည့်သွင်းပြီးပါက macOS နှင့် Linux သည် out of the box အလုပ်လုပ်သည်။ ၅။ Windows အတွက် WSL2 မှတစ်ဆင့် အသုံးပြုခြင်းသည် အကောင်းဆုံးဖြစ်သည်။

**Sidecar အလုပ်လုပ်ပုံ**

- Gateway သည် self-contained QMD home ကို
  `~/.openclaw/agents/<agentId>/qmd/` အောက်တွင် ရေးသားသည် (config + cache + sqlite DB)။
- Collections များကို `memory.qmd.paths` မှ `qmd collection add` ဖြင့် ဖန်တီးပြီး
  (workspace မေမိုရီ ဖိုင်များကိုပါ ပေါင်းထည့်သည်) ထို့နောက် `qmd update` + `qmd embed` ကို
  boot အချိန်နှင့် သတ်မှတ်နိုင်သော အချိန်အInterval (`memory.qmd.update.interval`,
  ပုံမှန် 5 မိနစ်) တွင် လည်ပတ်စေသည်။
- Boot refresh ကို ယခု ပုံမှန်အားဖြင့် background တွင် လည်ပတ်စေသဖြင့် chat စတင်မှု မပိတ်ဆို့တော့ပါ။ ယခင်
  blocking အပြုအမူကို ဆက်ထားလိုပါက `memory.qmd.update.waitForBootSync = true` ကို သတ်မှတ်ပါ။
- ၆။ ရှာဖွေမှုများကို `qmd query --json` ဖြင့် လုပ်ဆောင်သည်။ ၇။ QMD မအောင်မြင်ပါက သို့မဟုတ် binary မရှိပါက၊ OpenClaw သည် builtin SQLite manager သို့ အလိုအလျောက် ပြန်လည်ပြောင်းသုံးပြီး memory tools များ ဆက်လက်အလုပ်လုပ်နိုင်စေရန် ထောက်ပံ့ပေးသည်။
- OpenClaw သည် ယနေ့အချိန်တွင် QMD embed batch-size tuning ကို မဖော်ပြပါ။ batch အပြုအမူကို
  QMD ကိုယ်တိုင် ထိန်းချုပ်သည်။
- **ပထမဆုံး search သည် နှေးကွေးနိုင်သည်**: ပထမဆုံး `qmd query` လည်ပတ်ချိန်တွင် QMD သည် local GGUF models (reranker/query
  expansion) များကို ဒေါင်းလုပ်လုပ်နိုင်သည်။
  - OpenClaw သည် QMD လည်ပတ်ချိန်တွင် `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` ကို အလိုအလျောက် သတ်မှတ်ပေးသည်။
  - Model များကို ကိုယ်တိုင် ကြိုတင် ဒေါင်းလုပ်လုပ်ပြီး (OpenClaw အသုံးပြုသည့် index ကို အပူပေးလိုပါက)
    agent ၏ XDG dirs ဖြင့် one-off query တစ်ခုကို လည်ပတ်ပါ။

    ၈။ OpenClaw ၏ QMD state သည် သင့် **state dir** အောက်တွင် ရှိသည် (မူလအားဖြင့် `~/.openclaw`)။
    ၉။ OpenClaw အသုံးပြုသည့် XDG vars တူညီစွာ export လုပ်ခြင်းဖြင့် `qmd` ကို တူညီသော index ကိုညွှန်ပြနိုင်သည်:

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
- ၁၀။ `scope`: [`session.sendPolicy`](/gateway/configuration#session) နှင့် တူညီသော schema ဖြစ်သည်။
  ၁၁။ မူလသတ်မှတ်ချက်မှာ DM-only ဖြစ်သည် (`deny` အားလုံး၊ `allow` direct chats) ဖြစ်ပြီး group/channel များတွင် QMD hits များ ပြသလိုပါက လျော့ပေါ့နိုင်သည်။
- `scope` သည် search ကို ငြင်းပယ်ပါက OpenClaw သည် derived `channel`/`chatType` နှင့်အတူ warning ကို log ထားပြီး အလွတ်ရလဒ်များကို debug လုပ်ရန် လွယ်ကူစေပါသည်။
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
- ၁၂။ `qmd` လည်ပတ်သောအခါ `status().backend = "qmd"` ဟု tag လုပ်ထားသဖြင့် diagnostics တွင် မည်သည့် engine က ရလဒ်များကို ပံ့ပိုးခဲ့သည်ကို ပြသနိုင်သည်။ ၁၃။ QMD subprocess ထွက်သွားပါက သို့မဟုတ် JSON output ကို parse မလုပ်နိုင်ပါက၊ search manager သည် warning ကို log လုပ်ပြီး QMD ပြန်လည်အလုပ်လုပ်လာသည်အထိ builtin provider (ရှိပြီးသား Markdown embeddings) ကို ပြန်ပေးသည်။

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

- ၁၄။ OpenAI နှင့် Gemini embeddings အတွက် မူလအနေဖြင့် ဖွင့်ထားသည်။ ၁၅။ ပိတ်လိုပါက `agents.defaults.memorySearch.remote.batch.enabled = false` ဟု သတ်မှတ်ပါ။
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

- ၁၆။ `memory_search` သည် `MEMORY.md` နှင့် `memory/**/*.md` ထဲမှ Markdown chunks (~400 token ပန်းတိုင်၊ 80-token overlap) ကို semantic အရ ရှာဖွေသည်။ ၁၇။ snippet စာသား (~700 chars အထိ ကန့်သတ်), file path, line range, score, provider/model နှင့် local → remote embeddings သို့ fallback ဖြစ်ခဲ့/မဖြစ်ခဲ့ ကို ပြန်ပေးသည်။ ၁၈။ ဖိုင်အပြည့်အစုံ payload ကို မပြန်ပေးပါ။
- ၁၉။ `memory_get` သည် သတ်မှတ်ထားသော memory Markdown ဖိုင် (workspace-relative) ကို ဖတ်ပြီး၊ လိုအပ်ပါက စတင်လိုင်းနှင့် လိုင်းအရေအတွက် N ကို သတ်မှတ်နိုင်သည်။ ၂၀။ `MEMORY.md` / `memory/` အပြင်ဘက်ရှိ paths များကို ငြင်းပယ်သည်။
- ကိရိယာ ၂ ခုစလုံးသည် agent အတွက် `memorySearch.enabled` true ဖြစ်မှသာ ဖွင့်ထားသည်။

### What gets indexed (and when)

- ဖိုင်အမျိုးအစား: Markdown သာ (`MEMORY.md`, `memory/**/*.md`)။
- Index သိမ်းဆည်းရာ: per-agent SQLite ကို `~/.openclaw/memory/<agentId>.sqlite` တွင် သိမ်းဆည်းသည် (`agents.defaults.memorySearch.store.path` ဖြင့် ချိန်ညှိနိုင်ပြီး `{agentId}` token ကို ထောက်ပံ့သည်)။
- Freshness: `MEMORY.md` + `memory/` ကို watcher လုပ်ထားပြီး index ကို dirty အဖြစ်မှတ်သားပါသည် (debounce 1.5s)။ ၂၂။ Sync ကို session စတင်ချိန်၊ search လုပ်ချိန် သို့မဟုတ် အချိန်အပိုင်းအခြားအလိုက် စီစဉ်ထားပြီး asynchronous အနေဖြင့် လည်ပတ်သည်။ ၂၃။ Session transcripts များသည် delta thresholds ကို အသုံးပြု၍ background sync ကို trigger လုပ်သည်။
- ၂၄။ Reindex triggers: index သည် embedding **provider/model + endpoint fingerprint + chunking params** ကို သိမ်းဆည်းထားသည်။ ၂၅။ အဆိုပါ အချက်များထဲမှ တစ်ခုခု ပြောင်းလဲပါက OpenClaw သည် အလိုအလျောက် reset လုပ်ပြီး store အပြည့်အစုံကို reindex လုပ်သည်။

### Hybrid search (BM25 + vector)

ဖွင့်ထားပါက OpenClaw သည် —

- **Vector similarity** (semantic ကိုက်ညီမှု၊ စကားလုံး မတူနိုင်)
- **BM25 keyword relevance** (ID များ၊ env vars၊ code symbols ကဲ့သို့ တိကျသော token များ)

တို့ကို ပေါင်းစပ် အသုံးပြုသည်။

#### Why hybrid?

၂၆။ Vector search သည် “အဓိပ္ပါယ်တူညီမှု” ကို ရှာဖွေရန် အလွန်ကောင်းမွန်သည်:

- ၂၇။ “Mac Studio gateway host” နှင့် “gateway ကို လည်ပတ်နေသော စက်”
- ၂၈။ “debounce file updates” နှင့် “ရေးသွင်းမှုတိုင်းတွင် indexing မလုပ်ရန်”

၂၉။ သို့သော် တိကျပြီး signal မြင့်သော tokens များအတွက် အားနည်းနိုင်သည်:

- IDs (`a828e60`, `b3b9895a…`)
- code symbols (`memorySearch.query.hybrid`)
- error strings (“sqlite-vec unavailable”)

၃၀။ BM25 (full-text) သည် ဆန့်ကျင်ဘက်ဖြစ်ပြီး တိကျသော tokens များတွင် အားကောင်းသော်လည်း paraphrases များတွင် အားနည်းသည်။
၃၁။ Hybrid search သည် လက်တွေ့ကျသော အလယ်လမ်းဖြစ်ပြီး **retrieval signals နှစ်မျိုးလုံးကို အသုံးပြုခြင်း** ဖြင့် “natural language” queries နှင့် “needle in a haystack” queries နှစ်မျိုးလုံးအတွက် ကောင်းမွန်သော ရလဒ်များကို ရရှိစေသည်။

#### How we merge results (the current design)

၃၂။ Implementation sketch:

1. ၃၃။ နှစ်ဖက်စလုံးမှ candidate pool ကို ရယူပါ:

- နှစ်ဘက်စလုံးမှ candidate pool ကို ရယူသည် —
- ၃၄။ **BM25**: FTS5 BM25 rank ဖြင့် top `maxResults * candidateMultiplier` (နိမ့်လေလေ ပိုကောင်း)။

2. **Vector**: cosine similarity အရ ထိပ်ဆုံး `maxResults * candidateMultiplier`။

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. ၃၅။ chunk id အလိုက် candidates များကို union လုပ်ပြီး weighted score ကို တွက်ချက်ပါ:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

မှတ်ချက်များ —

- ၃၆။ `vectorWeight` + `textWeight` ကို config resolution တွင် 1.0 သို့ normalize လုပ်ထားသဖြင့် weights များသည် ရာခိုင်နှုန်းများကဲ့သို့ အပြုအမူပြုသည်။
- ၃၇။ embeddings မရနိုင်ပါက (သို့မဟုတ် provider မှ zero-vector ပြန်ပါက) BM25 ကို ဆက်လက်လုပ်ဆောင်ပြီး keyword matches များကို ပြန်ပေးသည်။
- ၃၈။ FTS5 ကို မဖန်တီးနိုင်ပါက vector-only search ကို ထိန်းထားပြီး hard failure မလုပ်ပါ။

၃၉။ ၎င်းသည် “IR-theory perfect” မဟုတ်သော်လည်း ရိုးရှင်း၊ မြန်ဆန်ပြီး အမှန်တကယ်ရှိသော notes များတွင် recall/precision ကို တိုးတက်စေတတ်သည်။
၄၀။ နောက်ပိုင်းတွင် ပိုမိုရှုပ်ထွေးစေလိုပါက အများအားဖြင့် လုပ်ဆောင်သည့် နောက်တစ်ဆင့်များမှာ Reciprocal Rank Fusion (RRF) သို့မဟုတ် score normalization (min/max သို့မဟုတ် z-score) ကို ပေါင်းစပ်မီ လုပ်ခြင်း ဖြစ်သည်။

ဤဒီဇိုင်းသည် “IR-theory အပြည့်အစုံ” မဟုတ်သော်လည်း ရိုးရှင်း၊ မြန်ဆန်ပြီး လက်တွေ့ မှတ်စုများတွင် recall/precision ကို တိုးတက်စေတတ်သည်။
နောက်ထပ် အဆင့်မြင့်လိုပါက Reciprocal Rank Fusion (RRF) သို့မဟုတ် score normalization
(min/max သို့မဟုတ် z-score) ကို ပေါင်းစပ်နိုင်သည်။

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

၄၁။ OpenClaw သည် SQLite ထဲတွင် **chunk embeddings** ကို cache လုပ်နိုင်ပြီး reindexing နှင့် မကြာခဏ update များ (အထူးသဖြင့် session transcripts) တွင် မပြောင်းလဲသော စာသားများကို ပြန်လည် embed မလုပ်ရအောင် ကူညီသည်။

OpenClaw သည် **chunk embedding များကို SQLite တွင် cache လုပ်** နိုင်ပြီး
reindexing နှင့် မကြာခဏ update များ (အထူးသဖြင့် session transcript များ) တွင်
မပြောင်းလဲသော စာသားကို ပြန်လည် embed မလုပ်စေရန် ကူညီသည်။

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

၄၂။ ရွေးချယ်နိုင်စွာ **session transcripts** ကို index လုပ်ပြီး `memory_search` မှတစ်ဆင့် ပြသနိုင်သည်။
၄၃။ ဤအရာသည် experimental flag အောက်တွင်သာ အသုံးပြုနိုင်သည်။

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

မှတ်ချက်များ-

- ၄၄။ Session indexing သည် **opt-in** ဖြစ်ပြီး (မူလအားဖြင့် ပိတ်ထားသည်)။
- ၄၅။ Session updates များကို debounce လုပ်ပြီး delta thresholds ကို ကျော်လွန်သည့်အခါ **asynchronously index** လုပ်သည် (best-effort)။
- ၄၆။ `memory_search` သည် indexing ကို စောင့်မနေဘဲ လုပ်ဆောင်ပြီး background sync မပြီးမချင်း ရလဒ်များသည် အနည်းငယ်ဟောင်းနေနိုင်သည်။
- ၄၇။ ရလဒ်များတွင် snippet များသာ ပါဝင်ပြီး `memory_get` သည် memory ဖိုင်များအတွက်သာ ကန့်သတ်ထားသည်။
- ၄၈။ Session indexing ကို agent တစ်ခုချင်းစီအလိုက် ခွဲထားပြီး (ထို agent ၏ session logs များသာ index လုပ်သည်)။
- ၄၉။ Session logs များကို disk ပေါ်တွင် သိမ်းထားသည် (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`)။ ၅၀။ filesystem access ရှိသည့် process/user မည်သူမဆို ဖတ်နိုင်သောကြောင့် disk access ကို trust boundary အဖြစ် သတ်မှတ်၍ ဆက်ဆံပါ။ For stricter isolation, run agents under separate OS users or hosts.

Delta thresholds (defaults shown):

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

When the sqlite-vec extension is available, OpenClaw stores embeddings in a
SQLite virtual table (`vec0`) and performs vector distance queries in the
database. This keeps search fast without loading every embedding into JS.

sqlite-vec extension ရရှိနိုင်ပါက OpenClaw သည် embedding များကို
SQLite virtual table (`vec0`) တွင် သိမ်းဆည်းပြီး
database အတွင်းတွင် vector distance query များကို ဆောင်ရွက်သည်။
ဤနည်းလမ်းသည် embedding အားလုံးကို JS ထဲ မတင်ဘဲ search ကို မြန်ဆန်စေသည်။

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

- `enabled` defaults to true; when disabled, search falls back to in-process
  cosine similarity over stored embeddings.
- If the sqlite-vec extension is missing or fails to load, OpenClaw logs the
  error and continues with the JS fallback (no vector table).
- `extensionPath` overrides the bundled sqlite-vec path (useful for custom builds
  or non-standard install locations).

### Local embedding auto-download

- Default local embedding model: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 GB).
- When `memorySearch.provider = "local"`, `node-llama-cpp` resolves `modelPath`; if the GGUF is missing it **auto-downloads** to the cache (or `local.modelCacheDir` if set), then loads it. Downloads resume on retry.
- Native build requirement: run `pnpm approve-builds`, pick `node-llama-cpp`, then `pnpm rebuild node-llama-cpp`.
- Fallback: if local setup fails and `memorySearch.fallback = "openai"`, we automatically switch to remote embeddings (`openai/text-embedding-3-small` unless overridden) and record the reason.

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

မှတ်ချက်များ-

- `remote.*` takes precedence over `models.providers.openai.*`.
- `remote.headers` merge with OpenAI headers; remote wins on key conflicts. Omit `remote.headers` to use the OpenAI defaults.
