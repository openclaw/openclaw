---
summary: "Context engine: pluggable context assembly, compaction, and subagent lifecycle"
read_when:
  - You want to understand how OpenClaw assembles model context
  - You are switching between the legacy engine and a plugin engine
  - You are building a context engine plugin
title: "Context Engine"
---

# Context Engine

A **context engine** controls how OpenClaw builds model context for each run.
It decides which messages to include, how to summarize older history, and how
to manage context across subagent boundaries.

OpenClaw ships with a built-in `legacy` engine. Plugins can register
alternative engines that replace the entire context pipeline.

## Quick start

Check which engine is active:

```bash
openclaw doctor
# or inspect config directly:
cat ~/.openclaw/openclaw.json | jq '.plugins.slots.contextEngine'
```

### Installing a context engine plugin

Context engine plugins are installed like any other OpenClaw plugin. Install
first, then select the engine in the slot:

```bash
# Install from npm
openclaw plugins install @martian-engineering/lossless-claw

# Or install from a local path (for development)
openclaw plugins install -l ./my-context-engine
```

Then enable the plugin and select it as the active engine in your config:

```json5
// openclaw.json
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw", // must match the plugin's registered engine id
    },
    entries: {
      "lossless-claw": {
        enabled: true,
        // Plugin-specific config goes here (see the plugin's docs)
      },
    },
  },
}
```

Restart the gateway after installing and configuring.

To switch back to the built-in engine, set `contextEngine` to `"legacy"` (or
remove the key entirely — `"legacy"` is the default).

## How it works

Every time OpenClaw runs a model prompt, the context engine participates at
four lifecycle points:

1. **Ingest** — called when a new message is added to the session. The engine
   can store or index the message in its own data store.
2. **Assemble** — called before each model run. The engine returns an ordered
   set of messages (and an optional `systemPromptAddition`) that fit within
   the token budget.
3. **Compact** — called when the context window is full, or when the user runs
   `/compact`. The engine summarizes older history to free space.
4. **After turn** — called after a run completes. The engine can persist state,
   trigger background compaction, or update indexes.

### Subagent lifecycle (optional)

Engines can also manage context across subagent boundaries:

- **prepareSubagentSpawn** — set up shared state before a child session starts.
  Returns a rollback handle in case the spawn fails.
- **onSubagentEnded** — clean up when a subagent session completes or is swept.

### System prompt addition

The `assemble` method can return a `systemPromptAddition` string. OpenClaw
prepends this to the system prompt for the run. This lets engines inject
dynamic recall guidance, retrieval instructions, or context-aware hints
without requiring static workspace files.

## The legacy engine

The built-in `legacy` engine preserves OpenClaw's original behavior:

- **Ingest**: no-op (the session manager handles message persistence directly).
- **Assemble**: pass-through (the existing sanitize → validate → limit pipeline
  in the runtime handles context assembly).
- **Compact**: delegates to the built-in summarization compaction, which creates
  a single summary of older messages and keeps recent messages intact.
- **After turn**: no-op.

The legacy engine does not register tools or provide a `systemPromptAddition`.

When no `plugins.slots.contextEngine` is set (or it's set to `"legacy"`), this
engine is used automatically.

## Plugin engines

A plugin can register a context engine using the plugin API:

```ts
export default function register(api) {
  api.registerContextEngine("my-engine", () => ({
    info: {
      id: "my-engine",
      name: "My Context Engine",
      ownsCompaction: true,
    },

    async ingest({ sessionId, message, isHeartbeat }) {
      // Store the message in your data store
      return { ingested: true };
    },

    async assemble({ sessionId, messages, tokenBudget }) {
      // Return messages that fit the budget
      return {
        messages: buildContext(messages, tokenBudget),
        estimatedTokens: countTokens(messages),
        systemPromptAddition: "Use lcm_grep to search history...",
      };
    },

    async compact({ sessionId, force }) {
      // Summarize older context
      return { ok: true, compacted: true };
    },
  }));
}
```

Then enable it in config:

```json5
{
  plugins: {
    slots: {
      contextEngine: "my-engine",
    },
    entries: {
      "my-engine": {
        enabled: true,
      },
    },
  },
}
```

### The ContextEngine interface

Required methods:

| Method             | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `info`             | Engine id, name, version, and whether it owns compaction |
| `ingest(params)`   | Store a single message                                   |
| `assemble(params)` | Build context for a model run                            |
| `compact(params)`  | Summarize/reduce context                                 |

Optional methods:

| Method                         | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| `bootstrap(params)`            | Initialize engine state for a new session |
| `ingestBatch(params)`          | Ingest a completed turn as a batch        |
| `afterTurn(params)`            | Post-run lifecycle work                   |
| `prepareSubagentSpawn(params)` | Set up shared state for a child session   |
| `onSubagentEnded(params)`      | Clean up after a subagent ends            |
| `dispose()`                    | Release resources                         |

### ownsCompaction

When `info.ownsCompaction` is `true`, the engine manages its own compaction
lifecycle. OpenClaw will not trigger the built-in auto-compaction; instead it
delegates entirely to the engine's `compact()` method. The engine may also
run compaction proactively in `afterTurn()`.

When `false` or unset, OpenClaw's built-in auto-compaction logic runs
alongside the engine.

## Configuration reference

```json5
{
  plugins: {
    slots: {
      // Select the active context engine. Default: "legacy".
      // Set to a plugin id to use a plugin engine.
      contextEngine: "legacy",
    },
  },
}
```

The slot is exclusive — only one context engine can be active at a time. If
multiple plugins declare `kind: "context-engine"`, only the one selected in
`plugins.slots.contextEngine` loads. Others are disabled with diagnostics.

## Relationship to compaction and memory

- **Compaction** is one responsibility of the context engine. The legacy engine
  delegates to OpenClaw's built-in summarization. Plugin engines can implement
  any compaction strategy (DAG summaries, vector retrieval, etc.).
- **Memory plugins** (`plugins.slots.memory`) are separate from context engines.
  Memory plugins provide search/retrieval; context engines control what the
  model sees. They can work together — a context engine might use memory
  plugin data during assembly.
- **Session pruning** (trimming old tool results in-memory) still runs
  regardless of which context engine is active.

## Tips

- Use `openclaw doctor` to verify your engine is loading correctly.
- If switching engines, existing sessions continue with their current history.
  The new engine takes over for future runs.
- Engine errors are logged and surfaced in diagnostics. If a plugin engine
  fails to load, OpenClaw falls back to the legacy engine with a warning.
- For development, use `openclaw plugins install -l ./my-engine` to link a
  local plugin directory without copying.

See also: [Compaction](/concepts/compaction), [Context](/concepts/context),
[Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest).
