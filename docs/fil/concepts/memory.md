---
summary: "Paano gumagana ang memory ng OpenClaw (mga workspace file + awtomatikong memory flush)"
read_when:
  - Gusto mo ang layout ng memory file at workflow
  - Gusto mong i-tune ang awtomatikong pre-compaction memory flush
---

# Memory

Ang OpenClaw memory ay **plain Markdown sa agent workspace**. Ang mga file ang
pinagmumulan ng katotohanan; ang modelo ay “naaalala” lamang ang naisusulat sa disk.

Ang mga memory search tool ay ibinibigay ng aktibong memory plugin (default:
`memory-core`). Disable memory plugins with `plugins.slots.memory = "none"`.

## Mga memory file (Markdown)

Ginagamit ng default na workspace layout ang dalawang layer ng memory:

- `memory/YYYY-MM-DD.md`
  - Araw-araw na log (append-only).
  - Binabasa ang ngayon + kahapon sa simula ng session.
- `MEMORY.md` (opsyonal)
  - Kinuradang pangmatagalang memory.
  - **I-load lamang sa pangunahing, pribadong session** (hindi kailanman sa mga group context).

These files live under the workspace (`agents.defaults.workspace`, default
`~/.openclaw/workspace`). See [Agent workspace](/concepts/agent-workspace) for the full layout.

## Kailan magsusulat ng memory

- Ang mga desisyon, kagustuhan, at matitibay na katotohanan ay ilagay sa `MEMORY.md`.
- Ang pang-araw-araw na tala at tumatakbong konteksto ay ilagay sa `memory/YYYY-MM-DD.md`.
- Kapag may nagsabing “tandaan ito,” isulat ito (huwag itago sa RAM).
- This area is still evolving. It helps to remind the model to store memories; it will know what to do.
- Kung gusto mong manatili ang isang bagay, **hilingin sa bot na isulat ito** sa memory.

## Awtomatikong memory flush (pre-compaction ping)

When a session is **close to auto-compaction**, OpenClaw triggers a **silent,
agentic turn** that reminds the model to write durable memory **before** the
context is compacted. The default prompts explicitly say the model _may reply_,
but usually `NO_REPLY` is the correct response so the user never sees this turn.

Ito ay kinokontrol ng `agents.defaults.compaction.memoryFlush`:

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

Mga detalye:

- **Soft threshold**: nagti-trigger ang flush kapag tumawid ang session token estimate sa
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Tahimik** bilang default: kasama sa mga prompt ang `NO_REPLY` kaya walang naihahatid.
- **Dalawang prompt**: isang user prompt at isang system prompt ang nagdaragdag ng paalala.
- **Isang flush bawat compaction cycle** (sinusubaybayan sa `sessions.json`).
- **Dapat writable ang workspace**: kung tumatakbo ang session na naka-sandbox na may
  `workspaceAccess: "ro"` o `"none"`, nilalaktawan ang flush.

Para sa buong lifecycle ng compaction, tingnan ang
[Session management + compaction](/reference/session-management-compaction).

## Vector memory search

Maaaring bumuo ang OpenClaw ng maliit na vector index sa ibabaw ng `MEMORY.md` at `memory/*.md` upang
makahanap ang mga semantic query ng magkakaugnay na tala kahit magkaiba ang pananalita.

Mga default:

- Naka-enable bilang default.
- Binabantayan ang mga memory file para sa mga pagbabago (debounced).
- Uses remote embeddings by default. If `memorySearch.provider` is not set, OpenClaw auto-selects:
  1. `local` kung may naka-configure na `memorySearch.local.modelPath` at umiiral ang file.
  2. `openai` kung maresolba ang OpenAI key.
  3. `gemini` kung maresolba ang Gemini key.
  4. `voyage` kung maresolba ang Voyage key.
  5. Kung wala, mananatiling disabled ang memory search hanggang ma-configure.
- Ang local mode ay gumagamit ng node-llama-cpp at maaaring mangailangan ng `pnpm approve-builds`.
- Gumagamit ng sqlite-vec (kapag available) para pabilisin ang vector search sa loob ng SQLite.

Remote embeddings **require** an API key for the embedding provider. OpenClaw
resolves keys from auth profiles, `models.providers.*.apiKey`, or environment
variables. Codex OAuth only covers chat/completions and does **not** satisfy
embeddings for memory search. For Gemini, use `GEMINI_API_KEY` or
`models.providers.google.apiKey`. For Voyage, use `VOYAGE_API_KEY` or
`models.providers.voyage.apiKey`. When using a custom OpenAI-compatible endpoint,
set `memorySearch.remote.apiKey` (and optional `memorySearch.remote.headers`).

### QMD backend (eksperimental)

Set `memory.backend = "qmd"` to swap the built-in SQLite indexer for
[QMD](https://github.com/tobi/qmd): a local-first search sidecar that combines
BM25 + vectors + reranking. Markdown stays the source of truth; OpenClaw shells
out to QMD for retrieval. Key points:

**Mga paunang kinakailangan**

- Disabled by default. Opt in per-config (`memory.backend = "qmd"`).
- I-install ang QMD CLI nang hiwalay (`bun install -g https://github.com/tobi/qmd` o kumuha
  ng release) at tiyaking nasa `PATH` ng gateway ang `qmd` binary.
- Kailangan ng QMD ng SQLite build na nagpapahintulot ng extensions (`brew install sqlite` sa
  macOS).
- Tumatakbo ang QMD nang lokal sa pamamagitan ng Bun + `node-llama-cpp` at awtomatikong
  nagda-download ng GGUF models mula HuggingFace sa unang gamit (walang hiwalay na Ollama daemon).
- Pinapatakbo ng gateway ang QMD sa isang self-contained XDG home sa ilalim ng
  `~/.openclaw/agents/<agentId>/qmd/` sa pamamagitan ng pag-set ng `XDG_CONFIG_HOME` at
  `XDG_CACHE_HOME`.
- OS support: macOS and Linux work out of the box once Bun + SQLite are
  installed. Windows is best supported via WSL2.

**Paano tumatakbo ang sidecar**

- Isinusulat ng gateway ang isang self-contained na QMD home sa ilalim ng
  `~/.openclaw/agents/<agentId>/qmd/` (config + cache + sqlite DB).
- Ginagawa ang mga collection sa pamamagitan ng `qmd collection add` mula sa `memory.qmd.paths`
  (kasama ang mga default workspace memory file), pagkatapos ay tumatakbo ang `qmd update` + `qmd embed`
  sa boot at sa isang nako-configure na interval (`memory.qmd.update.interval`,
  default 5 m).
- Ang boot refresh ay tumatakbo na ngayon sa background bilang default upang hindi
  ma-block ang pagsisimula ng chat; i-set ang `memory.qmd.update.waitForBootSync = true` para panatilihin ang dating
  blocking na pag-uugali.
- Searches run via `qmd query --json`. If QMD fails or the binary is missing,
  OpenClaw automatically falls back to the builtin SQLite manager so memory tools
  keep working.
- Hindi pa inilalantad ng OpenClaw ang QMD embed batch-size tuning sa kasalukuyan; ang batch behavior ay
  kinokontrol mismo ng QMD.
- **Maaaring mabagal ang unang search**: maaaring mag-download ang QMD ng lokal na GGUF models
  (reranker/query expansion) sa unang pagtakbo ng `qmd query`.
  - Awtomatikong itinatakda ng OpenClaw ang `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` kapag pinapatakbo nito ang QMD.
  - Kung gusto mong i-pre-download ang mga model nang mano-mano (at painitin ang parehong index na
    ginagamit ng OpenClaw), magpatakbo ng one-off query gamit ang XDG dirs ng agent.

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

**Config surface (`memory.qmd.*`)**

- `command` (default `qmd`): i-override ang executable path.
- `includeDefaultMemory` (default `true`): awtomatikong i-index ang `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: magdagdag ng mga extra directory/file (`path`, opsyonal na `pattern`, opsyonal
  na stable `name`).
- `sessions`: mag-opt in sa session JSONL indexing (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: kinokontrol ang refresh cadence at execution ng maintenance:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: i-clamp ang recall payload (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: same schema as [`session.sendPolicy`](/gateway/configuration#session).
  Default is DM-only (`deny` all, `allow` direct chats); loosen it to surface QMD
  hits in groups/channels.
- Ang mga snippet na nagmula sa labas ng workspace ay lilitaw bilang
  `qmd/<collection>/<relative-path>` sa mga resulta ng `memory_search`; nauunawaan ng `memory_get`
  ang prefix na iyon at nagbabasa mula sa naka-configure na QMD collection root.
- Kapag `memory.qmd.sessions.enabled = true`, ini-export ng OpenClaw ang mga sanitized session
  transcript (User/Assistant turns) sa isang dedikadong QMD collection sa ilalim ng
  `~/.openclaw/agents/<id>/qmd/sessions/`, kaya maaaring i-recall ng `memory_search` ang mga kamakailang
  pag-uusap nang hindi hinahawakan ang builtin SQLite index.
- Ang mga `memory_search` snippet ay may kasama nang `Source: <path#line>` footer kapag
  ang `memory.citations` ay `auto`/`on`; i-set ang `memory.citations = "off"` upang panatilihing internal
  ang path metadata (natatanggap pa rin ng agent ang path para sa
  `memory_get`, ngunit inaalis ng snippet text ang footer at binabalaan ng system prompt
  ang agent na huwag itong banggitin).

**Halimbawa**

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

**Mga citation at fallback**

- Nalalapat ang `memory.citations` anuman ang backend (`auto`/`on`/`off`).
- When `qmd` runs, we tag `status().backend = "qmd"` so diagnostics show which
  engine served the results. If the QMD subprocess exits or JSON output can’t be
  parsed, the search manager logs a warning and returns the builtin provider
  (existing Markdown embeddings) until QMD recovers.

### Mga karagdagang path ng memory

Kung gusto mong i-index ang mga Markdown file sa labas ng default workspace layout, magdagdag
ng mga tahasang path:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Mga tala:

- Maaaring absolute o workspace-relative ang mga path.
- Ang mga directory ay ini-scan nang recursively para sa mga `.md` file.
- Tanging mga Markdown file lamang ang ini-index.
- Binabalewala ang mga symlink (file man o directory).

### Gemini embeddings (native)

I-set ang provider sa `gemini` upang direktang gamitin ang Gemini embeddings API:

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

Mga tala:

- Opsyonal ang `remote.baseUrl` (default sa Gemini API base URL).
- Pinapayagan ng `remote.headers` na magdagdag ng mga extra header kung kailangan.
- Default na model: `gemini-embedding-001`.

Kung gusto mong gumamit ng **custom OpenAI-compatible endpoint** (OpenRouter, vLLM, o proxy),
maaari mong gamitin ang `remote` configuration kasama ang OpenAI provider:

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

Kung ayaw mong mag-set ng API key, gamitin ang `memorySearch.provider = "local"` o i-set ang
`memorySearch.fallback = "none"`.

Mga fallback:

- Ang `memorySearch.fallback` ay maaaring `openai`, `gemini`, `local`, o `none`.
- Ginagamit lamang ang fallback provider kapag pumalya ang pangunahing embedding provider.

Batch indexing (OpenAI + Gemini):

- Enabled by default for OpenAI and Gemini embeddings. Set `agents.defaults.memorySearch.remote.batch.enabled = false` to disable.
- Ang default na pag-uugali ay naghihintay sa pagkumpleto ng batch; i-tune ang `remote.batch.wait`, `remote.batch.pollIntervalMs`, at `remote.batch.timeoutMinutes` kung kailangan.
- I-set ang `remote.batch.concurrency` upang kontrolin kung ilang batch job ang isinusumite namin nang sabay (default: 2).
- Nalalapat ang batch mode kapag `memorySearch.provider = "openai"` o `"gemini"` at gumagamit ng kaukulang API key.
- Gumagamit ang mga Gemini batch job ng async embeddings batch endpoint at nangangailangan ng availability ng Gemini Batch API.

Bakit mabilis at mura ang OpenAI batch:

- Para sa malalaking backfill, kadalasang ang OpenAI ang pinakamabilis na opsyon na sinusuportahan namin dahil maaari kaming magsumite ng maraming embedding request sa iisang batch job at hayaang iproseso ito ng OpenAI nang asynchronous.
- Nag-aalok ang OpenAI ng discounted pricing para sa Batch API workloads, kaya ang malalaking indexing run ay karaniwang mas mura kaysa sa pagpapadala ng kaparehong mga request nang synchronous.
- Tingnan ang OpenAI Batch API docs at pricing para sa mga detalye:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Halimbawa ng config:

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

Mga tool:

- `memory_search` — nagbabalik ng mga snippet na may file + saklaw ng linya.
- `memory_get` — binabasa ang nilalaman ng memory file ayon sa path.

Local mode:

- I-set ang `agents.defaults.memorySearch.provider = "local"`.
- Ibigay ang `agents.defaults.memorySearch.local.modelPath` (GGUF o `hf:` URI).
- Opsyonal: i-set ang `agents.defaults.memorySearch.fallback = "none"` upang maiwasan ang remote fallback.

### Paano gumagana ang mga memory tool

- `memory_search` semantically searches Markdown chunks (~400 token target, 80-token overlap) from `MEMORY.md` + `memory/**/*.md`. It returns snippet text (capped ~700 chars), file path, line range, score, provider/model, and whether we fell back from local → remote embeddings. No full file payload is returned.
- `memory_get` reads a specific memory Markdown file (workspace-relative), optionally from a starting line and for N lines. Paths outside `MEMORY.md` / `memory/` are rejected.
- Ang parehong tool ay naka-enable lamang kapag nagre-resolve sa true ang `memorySearch.enabled` para sa agent.

### Ano ang ini-index (at kailan)

- Uri ng file: Markdown lamang (`MEMORY.md`, `memory/**/*.md`).
- Imbakan ng index: per-agent SQLite sa `~/.openclaw/memory/<agentId>.sqlite` (nako-configure sa pamamagitan ng `agents.defaults.memorySearch.store.path`, sumusuporta sa `{agentId}` token).
- Freshness: watcher on `MEMORY.md` + `memory/` marks the index dirty (debounce 1.5s). Sync is scheduled on session start, on search, or on an interval and runs asynchronously. Session transcripts use delta thresholds to trigger background sync.
- Reindex triggers: the index stores the embedding **provider/model + endpoint fingerprint + chunking params**. If any of those change, OpenClaw automatically resets and reindexes the entire store.

### Hybrid search (BM25 + vector)

Kapag naka-enable, pinagsasama ng OpenClaw ang:

- **Vector similarity** (semantic match, maaaring magkaiba ang pananalita)
- **BM25 keyword relevance** (eksaktong token gaya ng mga ID, env var, simbolo ng code)

Kung hindi available ang full-text search sa iyong platform, babalik ang OpenClaw sa vector-only search.

#### Bakit hybrid?

Magaling ang vector search sa “pareho ang ibig sabihin”:

- “Mac Studio gateway host” vs “ang makinang nagpapatakbo ng gateway”
- “debounce file updates” vs “iwasan ang pag-index sa bawat write”

Ngunit mahina ito sa eksaktong, high-signal na token:

- Mga ID (`a828e60`, `b3b9895a…`)
- mga simbolo ng code (`memorySearch.query.hybrid`)
- mga error string (“sqlite-vec unavailable”)

BM25 (full-text) is the opposite: strong at exact tokens, weaker at paraphrases.
Hybrid search is the pragmatic middle ground: **use both retrieval signals** so you get
good results for both “natural language” queries and “needle in a haystack” queries.

#### Paano namin pinagsasama ang mga resulta (kasalukuyang disenyo)

Balangkas ng implementasyon:

1. Kumuha ng candidate pool mula sa magkabilang panig:

- **Vector**: top `maxResults * candidateMultiplier` ayon sa cosine similarity.
- **BM25**: top `maxResults * candidateMultiplier` ayon sa FTS5 BM25 rank (mas mababa ay mas maganda).

2. I-convert ang BM25 rank sa 0..1-ish na score:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Pagsamahin ang mga candidate ayon sa chunk id at kalkulahin ang weighted score:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Mga tala:

- Ang `vectorWeight` + `textWeight` ay normalisado sa 1.0 sa config resolution, kaya kumikilos ang mga timbang bilang porsiyento.
- Kung hindi available ang embeddings (o nagbalik ang provider ng zero-vector), pinapatakbo pa rin namin ang BM25 at ibinabalik ang mga keyword match.
- Kung hindi malikha ang FTS5, pinapanatili namin ang vector-only search (walang hard failure).

This isn’t “IR-theory perfect”, but it’s simple, fast, and tends to improve recall/precision on real notes.
If we want to get fancier later, common next steps are Reciprocal Rank Fusion (RRF) or score normalization
(min/max or z-score) before mixing.

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

Maaaring i-cache ng OpenClaw ang **chunk embeddings** sa SQLite upang ang muling pag-index at madalas na update (lalo na ang mga session transcript) ay hindi na muling mag-embed ng hindi nagbago na teksto.

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

### Session memory search (eksperimental)

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

Mga tala:

- Ang session indexing ay **opt-in** (off bilang default).
- Ang mga update ng session ay debounced at **ini-index nang asynchronous** kapag tumawid sa mga delta threshold (best-effort).
- Ang `memory_search` ay hindi kailanman nagba-block sa indexing; maaaring bahagyang luma ang mga resulta hanggang matapos ang background sync.
- Ang mga resulta ay snippet lamang; nananatiling limitado sa mga memory file ang `memory_get`.
- Ang session indexing ay hiwalay bawat agent (tanging ang mga session log ng agent na iyon ang ini-index).
- Session logs live on disk (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Any process/user with filesystem access can read them, so treat disk access as the trust boundary. Para sa mas mahigpit na isolation, patakbuhin ang mga agent sa magkakahiwalay na OS users o hosts.

Mga delta threshold (ipinapakita ang mga default):

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

Kapag available ang sqlite-vec extension, iniimbak ng OpenClaw ang mga embedding sa isang
SQLite virtual table (`vec0`) at nagsasagawa ng mga vector distance query sa
database. Pinananatiling mabilis ang paghahanap nito nang hindi nilo-load ang bawat embedding sa JS.

Configuration (opsyonal):

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

Mga tala:

- Ang `enabled` ay default na true; kapag naka-disable, babalik ang search sa in-process
  cosine similarity sa mga nakaimbak na embedding.
- Kung nawawala o pumalya ang sqlite-vec extension, nagla-log ng error ang OpenClaw at
  nagpapatuloy gamit ang JS fallback (walang vector table).
- Ang `extensionPath` ay nag-o-override sa bundled sqlite-vec path (kapaki-pakinabang para sa custom build
  o hindi karaniwang lokasyon ng install).

### Awtomatikong pag-download ng local embedding

- Default na local embedding model: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 GB).
- Kapag `memorySearch.provider = "local"`, nireresolba ng `node-llama-cpp` ang `modelPath`; kung wala ang GGUF, ito ay **auto-downloads** papunta sa cache (o `local.modelCacheDir` kung naka-set), at saka nilo-load. Nagpapatuloy ang mga download kapag nag-retry.
- Kinakailangan sa native build: patakbuhin ang `pnpm approve-builds`, piliin ang `node-llama-cpp`, pagkatapos ay `pnpm rebuild node-llama-cpp`.
- Fallback: kung pumalya ang local setup at `memorySearch.fallback = "openai"`, awtomatiko kaming lilipat sa remote embeddings (`openai/text-embedding-3-small` maliban kung i-override) at itinatala ang dahilan.

### Halimbawa ng custom OpenAI-compatible endpoint

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

Mga tala:

- Mas may prioridad ang `remote.*` kaysa sa `models.providers.openai.*`.
- Ang `remote.headers` ay nagme-merge sa mga OpenAI header; nananalo ang remote kapag may key conflicts. Tanggalin ang `remote.headers` para gamitin ang mga default ng OpenAI.
