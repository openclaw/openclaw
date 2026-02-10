---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Memory"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How OpenClaw memory works (workspace files + automatic memory flush)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want the memory file layout and workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to tune the automatic pre-compaction memory flush（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw memory is **plain Markdown in the agent workspace**. The files are the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source of truth; the model only "remembers" what gets written to disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Memory search tools are provided by the active memory plugin (default:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`memory-core`). Disable memory plugins with `plugins.slots.memory = "none"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Memory files (Markdown)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The default workspace layout uses two memory layers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory/YYYY-MM-DD.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Daily log (append-only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Read today + yesterday at session start.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `MEMORY.md` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Curated long-term memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Only load in the main, private session** (never in group contexts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These files live under the workspace (`agents.defaults.workspace`, default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/workspace`). See [Agent workspace](/concepts/agent-workspace) for the full layout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## When to write memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Decisions, preferences, and durable facts go to `MEMORY.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Day-to-day notes and running context go to `memory/YYYY-MM-DD.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If someone says "remember this," write it down (do not keep it in RAM).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This area is still evolving. It helps to remind the model to store memories; it will know what to do.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you want something to stick, **ask the bot to write it** into memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Automatic memory flush (pre-compaction ping)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a session is **close to auto-compaction**, OpenClaw triggers a **silent,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agentic turn** that reminds the model to write durable memory **before** the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
context is compacted. The default prompts explicitly say the model _may reply_,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
but usually `NO_REPLY` is the correct response so the user never sees this turn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is controlled by `agents.defaults.compaction.memoryFlush`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      compaction: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        reserveTokensFloor: 20000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        memoryFlush: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          softThresholdTokens: 4000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPrompt: "Session nearing compaction. Store durable memories now.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Soft threshold**: flush triggers when the session token estimate crosses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `contextWindow - reserveTokensFloor - softThresholdTokens`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Silent** by default: prompts include `NO_REPLY` so nothing is delivered.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Two prompts**: a user prompt plus a system prompt append the reminder.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **One flush per compaction cycle** (tracked in `sessions.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace must be writable**: if the session runs sandboxed with（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `workspaceAccess: "ro"` or `"none"`, the flush is skipped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the full compaction lifecycle, see（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Session management + compaction](/reference/session-management-compaction).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Vector memory search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can build a small vector index over `MEMORY.md` and `memory/*.md` so（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
semantic queries can find related notes even when wording differs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enabled by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Watches memory files for changes (debounced).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configure memory search under `agents.defaults.memorySearch` (not top-level（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `memorySearch`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses remote embeddings by default. If `memorySearch.provider` is not set, OpenClaw auto-selects:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  1. `local` if a `memorySearch.local.modelPath` is configured and the file exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  2. `openai` if an OpenAI key can be resolved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  3. `gemini` if a Gemini key can be resolved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  4. `voyage` if a Voyage key can be resolved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  5. Otherwise memory search stays disabled until configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local mode uses node-llama-cpp and may require `pnpm approve-builds`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses sqlite-vec (when available) to accelerate vector search inside SQLite.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote embeddings **require** an API key for the embedding provider. OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resolves keys from auth profiles, `models.providers.*.apiKey`, or environment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
variables. Codex OAuth only covers chat/completions and does **not** satisfy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
embeddings for memory search. For Gemini, use `GEMINI_API_KEY` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`models.providers.google.apiKey`. For Voyage, use `VOYAGE_API_KEY` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`models.providers.voyage.apiKey`. When using a custom OpenAI-compatible endpoint,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
set `memorySearch.remote.apiKey` (and optional `memorySearch.remote.headers`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### QMD backend (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `memory.backend = "qmd"` to swap the built-in SQLite indexer for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[QMD](https://github.com/tobi/qmd): a local-first search sidecar that combines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BM25 + vectors + reranking. Markdown stays the source of truth; OpenClaw shells（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
out to QMD for retrieval. Key points:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Prereqs**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disabled by default. Opt in per-config (`memory.backend = "qmd"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install the QMD CLI separately (`bun install -g https://github.com/tobi/qmd` or grab（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a release) and make sure the `qmd` binary is on the gateway’s `PATH`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- QMD needs an SQLite build that allows extensions (`brew install sqlite` on（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  macOS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- QMD runs fully locally via Bun + `node-llama-cpp` and auto-downloads GGUF（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models from HuggingFace on first use (no separate Ollama daemon required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway runs QMD in a self-contained XDG home under（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `~/.openclaw/agents/<agentId>/qmd/` by setting `XDG_CONFIG_HOME` and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `XDG_CACHE_HOME`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OS support: macOS and Linux work out of the box once Bun + SQLite are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  installed. Windows is best supported via WSL2.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**How the sidecar runs**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway writes a self-contained QMD home under（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `~/.openclaw/agents/<agentId>/qmd/` (config + cache + sqlite DB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Collections are created via `qmd collection add` from `memory.qmd.paths`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (plus default workspace memory files), then `qmd update` + `qmd embed` run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  on boot and on a configurable interval (`memory.qmd.update.interval`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  default 5 m).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway now initializes the QMD manager on startup, so periodic update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  timers are armed even before the first `memory_search` call.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Boot refresh now runs in the background by default so chat startup is not（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  blocked; set `memory.qmd.update.waitForBootSync = true` to keep the previous（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  blocking behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Searches run via `qmd query --json`, scoped to OpenClaw-managed collections.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  If QMD fails or the binary is missing,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  OpenClaw automatically falls back to the builtin SQLite manager so memory tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  keep working.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw does not expose QMD embed batch-size tuning today; batch behavior is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  controlled by QMD itself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **First search may be slow**: QMD may download local GGUF models (reranker/query（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  expansion) on the first `qmd query` run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - OpenClaw sets `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` automatically when it runs QMD.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If you want to pre-download models manually (and warm the same index OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    uses), run a one-off query with the agent’s XDG dirs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    OpenClaw’s QMD state lives under your **state dir** (defaults to `~/.openclaw`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    You can point `qmd` at the exact same index by exporting the same XDG vars（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    OpenClaw uses:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    # Pick the same state dir OpenClaw uses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      STATE_DIR="$HOME/.moltbot"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    fi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    # (Optional) force an index refresh + embeddings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    qmd update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    qmd embed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    # Warm up / trigger first-time model downloads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    qmd query "test" -c memory-root --json >/dev/null 2>&1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Config surface (`memory.qmd.*`)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `command` (default `qmd`): override the executable path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `includeDefaultMemory` (default `true`): auto-index `MEMORY.md` + `memory/**/*.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `paths[]`: add extra directories/files (`path`, optional `pattern`, optional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  stable `name`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions`: opt into session JSONL indexing (`enabled`, `retentionDays`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `exportDir`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `update`: controls refresh cadence and maintenance execution:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `limits`: clamp recall payload (`maxResults`, `maxSnippetChars`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `maxInjectedChars`, `timeoutMs`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scope`: same schema as [`session.sendPolicy`](/gateway/configuration#session).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Default is DM-only (`deny` all, `allow` direct chats); loosen it to surface QMD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  hits in groups/channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `scope` denies a search, OpenClaw logs a warning with the derived（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `channel`/`chatType` so empty results are easier to debug.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Snippets sourced outside the workspace show up as（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `qmd/<collection>/<relative-path>` in `memory_search` results; `memory_get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  understands that prefix and reads from the configured QMD collection root.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `memory.qmd.sessions.enabled = true`, OpenClaw exports sanitized session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  transcripts (User/Assistant turns) into a dedicated QMD collection under（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `~/.openclaw/agents/<id>/qmd/sessions/`, so `memory_search` can recall recent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  conversations without touching the builtin SQLite index.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory_search` snippets now include a `Source: <path#line>` footer when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `memory.citations` is `auto`/`on`; set `memory.citations = "off"` to keep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the path metadata internal (the agent still receives the path for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `memory_get`, but the snippet text omits the footer and the system prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  warns the agent not to cite it).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
memory: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  backend: "qmd",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  citations: "auto",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  qmd: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    includeDefaultMemory: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    update: { interval: "5m", debounceMs: 15000 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    limits: { maxResults: 6, timeoutMs: 4000 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scope: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      default: "deny",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      rules: [{ action: "allow", match: { chatType: "direct" } }]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    paths: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { name: "docs", path: "~/notes", pattern: "**/*.md" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Citations & fallback**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory.citations` applies regardless of backend (`auto`/`on`/`off`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `qmd` runs, we tag `status().backend = "qmd"` so diagnostics show which（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  engine served the results. If the QMD subprocess exits or JSON output can’t be（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  parsed, the search manager logs a warning and returns the builtin provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (existing Markdown embeddings) until QMD recovers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Additional memory paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to index Markdown files outside the default workspace layout, add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
explicit paths:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Paths can be absolute or workspace-relative.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Directories are scanned recursively for `.md` files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only Markdown files are indexed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Symlinks are ignored (files or directories).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gemini embeddings (native)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set the provider to `gemini` to use the Gemini embeddings API directly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "gemini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: "gemini-embedding-001",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remote: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "YOUR_GEMINI_API_KEY"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remote.baseUrl` is optional (defaults to the Gemini API base URL).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remote.headers` lets you add extra headers if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default model: `gemini-embedding-001`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to use a **custom OpenAI-compatible endpoint** (OpenRouter, vLLM, or a proxy),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
you can use the `remote` configuration with the OpenAI provider:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "openai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: "text-embedding-3-small",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remote: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.example.com/v1/",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        headers: { "X-Custom-Header": "value" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you don't want to set an API key, use `memorySearch.provider = "local"` or set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`memorySearch.fallback = "none"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fallbacks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memorySearch.fallback` can be `openai`, `gemini`, `local`, or `none`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The fallback provider is only used when the primary embedding provider fails.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Batch indexing (OpenAI + Gemini + Voyage):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disabled by default. Set `agents.defaults.memorySearch.remote.batch.enabled = true` to enable for large-corpus indexing (OpenAI, Gemini, and Voyage).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default behavior waits for batch completion; tune `remote.batch.wait`, `remote.batch.pollIntervalMs`, and `remote.batch.timeoutMinutes` if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `remote.batch.concurrency` to control how many batch jobs we submit in parallel (default: 2).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Batch mode applies when `memorySearch.provider = "openai"` or `"gemini"` and uses the corresponding API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gemini batch jobs use the async embeddings batch endpoint and require Gemini Batch API availability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Why OpenAI batch is fast + cheap:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For large backfills, OpenAI is typically the fastest option we support because we can submit many embedding requests in a single batch job and let OpenAI process them asynchronously.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI offers discounted pricing for Batch API workloads, so large indexing runs are usually cheaper than sending the same requests synchronously.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See the OpenAI Batch API docs and pricing for details:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "openai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: "text-embedding-3-small",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      fallback: "openai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remote: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        batch: { enabled: true, concurrency: 2 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sync: { watch: true }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory_search` — returns snippets with file + line ranges.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory_get` — read memory file content by path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local mode:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `agents.defaults.memorySearch.provider = "local"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provide `agents.defaults.memorySearch.local.modelPath` (GGUF or `hf:` URI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional: set `agents.defaults.memorySearch.fallback = "none"` to avoid remote fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How the memory tools work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory_search` semantically searches Markdown chunks (~400 token target, 80-token overlap) from `MEMORY.md` + `memory/**/*.md`. It returns snippet text (capped ~700 chars), file path, line range, score, provider/model, and whether we fell back from local → remote embeddings. No full file payload is returned.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory_get` reads a specific memory Markdown file (workspace-relative), optionally from a starting line and for N lines. Paths outside `MEMORY.md` / `memory/` are rejected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Both tools are enabled only when `memorySearch.enabled` resolves true for the agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What gets indexed (and when)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- File type: Markdown only (`MEMORY.md`, `memory/**/*.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Index storage: per-agent SQLite at `~/.openclaw/memory/<agentId>.sqlite` (configurable via `agents.defaults.memorySearch.store.path`, supports `{agentId}` token).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Freshness: watcher on `MEMORY.md` + `memory/` marks the index dirty (debounce 1.5s). Sync is scheduled on session start, on search, or on an interval and runs asynchronously. Session transcripts use delta thresholds to trigger background sync.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reindex triggers: the index stores the embedding **provider/model + endpoint fingerprint + chunking params**. If any of those change, OpenClaw automatically resets and reindexes the entire store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Hybrid search (BM25 + vector)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, OpenClaw combines:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Vector similarity** (semantic match, wording can differ)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BM25 keyword relevance** (exact tokens like IDs, env vars, code symbols)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If full-text search is unavailable on your platform, OpenClaw falls back to vector-only search.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Why hybrid?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Vector search is great at “this means the same thing”:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Mac Studio gateway host” vs “the machine running the gateway”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “debounce file updates” vs “avoid indexing on every write”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
But it can be weak at exact, high-signal tokens:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- IDs (`a828e60`, `b3b9895a…`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- code symbols (`memorySearch.query.hybrid`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- error strings (“sqlite-vec unavailable”)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BM25 (full-text) is the opposite: strong at exact tokens, weaker at paraphrases.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hybrid search is the pragmatic middle ground: **use both retrieval signals** so you get（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
good results for both “natural language” queries and “needle in a haystack” queries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### How we merge results (the current design)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Implementation sketch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Retrieve a candidate pool from both sides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Vector**: top `maxResults * candidateMultiplier` by cosine similarity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BM25**: top `maxResults * candidateMultiplier` by FTS5 BM25 rank (lower is better).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Convert BM25 rank into a 0..1-ish score:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `textScore = 1 / (1 + max(0, bm25Rank))`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Union candidates by chunk id and compute a weighted score:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `finalScore = vectorWeight * vectorScore + textWeight * textScore`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `vectorWeight` + `textWeight` is normalized to 1.0 in config resolution, so weights behave as percentages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If embeddings are unavailable (or the provider returns a zero-vector), we still run BM25 and return keyword matches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If FTS5 can’t be created, we keep vector-only search (no hard failure).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This isn’t “IR-theory perfect”, but it’s simple, fast, and tends to improve recall/precision on real notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If we want to get fancier later, common next steps are Reciprocal Rank Fusion (RRF) or score normalization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(min/max or z-score) before mixing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      query: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        hybrid: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          vectorWeight: 0.7,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          textWeight: 0.3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          candidateMultiplier: 4（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Embedding cache（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can cache **chunk embeddings** in SQLite so reindexing and frequent updates (especially session transcripts) don't re-embed unchanged text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cache: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxEntries: 50000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session memory search (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can optionally index **session transcripts** and surface them via `memory_search`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is gated behind an experimental flag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      experimental: { sessionMemory: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sources: ["memory", "sessions"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session indexing is **opt-in** (off by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session updates are debounced and **indexed asynchronously** once they cross delta thresholds (best-effort).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memory_search` never blocks on indexing; results can be slightly stale until background sync finishes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Results still include snippets only; `memory_get` remains limited to memory files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session indexing is isolated per agent (only that agent’s session logs are indexed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Session logs live on disk (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Any process/user with filesystem access can read them, so treat disk access as the trust boundary. For stricter isolation, run agents under separate OS users or hosts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delta thresholds (defaults shown):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sync: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sessions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          deltaBytes: 100000,   // ~100 KB（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          deltaMessages: 50     // JSONL lines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### SQLite vector acceleration (sqlite-vec)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the sqlite-vec extension is available, OpenClaw stores embeddings in a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SQLite virtual table (`vec0`) and performs vector distance queries in the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
database. This keeps search fast without loading every embedding into JS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configuration (optional):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      store: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        vector: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          extensionPath: "/path/to/sqlite-vec"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled` defaults to true; when disabled, search falls back to in-process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cosine similarity over stored embeddings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the sqlite-vec extension is missing or fails to load, OpenClaw logs the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  error and continues with the JS fallback (no vector table).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `extensionPath` overrides the bundled sqlite-vec path (useful for custom builds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  or non-standard install locations).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Local embedding auto-download（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default local embedding model: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0.6 GB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `memorySearch.provider = "local"`, `node-llama-cpp` resolves `modelPath`; if the GGUF is missing it **auto-downloads** to the cache (or `local.modelCacheDir` if set), then loads it. Downloads resume on retry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Native build requirement: run `pnpm approve-builds`, pick `node-llama-cpp`, then `pnpm rebuild node-llama-cpp`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fallback: if local setup fails and `memorySearch.fallback = "openai"`, we automatically switch to remote embeddings (`openai/text-embedding-3-small` unless overridden) and record the reason.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Custom OpenAI-compatible endpoint example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    memorySearch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "openai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: "text-embedding-3-small",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remote: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.example.com/v1/",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "YOUR_REMOTE_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        headers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "X-Organization": "org-id",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "X-Project": "project-id"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remote.*` takes precedence over `models.providers.openai.*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remote.headers` merge with OpenAI headers; remote wins on key conflicts. Omit `remote.headers` to use the OpenAI defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
