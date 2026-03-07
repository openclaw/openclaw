# @openclaw/langsmith-tracer

LangSmith tracing extension for the OpenClaw agent loop.

Traces every agent turn — LLM calls, tool calls, token usage, errors — to
[LangSmith](https://smith.langchain.com) using the OpenClaw plugin hook system.
No core files are modified; this extension is purely additive.

> **Fork-specific:** This extension lives in the `fritzebner/openclaw` fork and is
> not part of upstream OpenClaw. It is intentionally kept out of `src/` so merging
> upstream changes never touches tracing code.

---

## Trace hierarchy

Each agent turn produces one trace in LangSmith:

```
openclaw-agent  [chain]              ← full turn: user message → reply
  anthropic/claude-sonnet-4-5 [llm] ← turn 1: first LLM call
    bash  [tool]                     ← tool called by the LLM
    read_file  [tool]
  anthropic/claude-sonnet-4-5 [llm] ← turn 2: follow-up LLM call (after tools)
```

Each run shows:

- **chain**: prompt input, success/error, total duration
- **llm**: message history input, generated texts output, token usage (input/output/cache)
- **tool**: params input, result or error output, duration

---

## Hook to RunTree mapping

This table is the key reference for future maintainers.

| Plugin hook          | RunTree action                            | Data captured                               |
| -------------------- | ----------------------------------------- | ------------------------------------------- |
| `before_agent_start` | Create root `chain` run, `postRun()`      | `prompt`                                    |
| `llm_input`          | Create child `llm` run, `postRun()`       | system prompt, message history, image count |
| `before_tool_call`   | Create grandchild `tool` run, `postRun()` | tool name, params                           |
| `after_tool_call`    | `end()` + `patchRun()` on tool run        | result or error                             |
| `llm_output`         | `end()` + `patchRun()` on LLM run         | generated texts, token usage                |
| `agent_end`          | `end()` + `patchRun()` on root run        | success flag, error message                 |

**Correlation key:** `agentId` from `PluginHookAgentContext` / `PluginHookToolContext`.
Tool hooks carry `PluginHookToolContext` (no `sessionId`), so `agentId` is used as the
stable key across all hook types.

**State:** `LangSmithTracer` maintains a `Map<agentId, SessionTrace>` in memory.
Each entry holds the root run, the current LLM run, and a stack of pending tool runs.

---

## Setup

### 1. Set environment variables

```bash
export LANGSMITH_API_KEY=ls__...          # required — get from smith.langchain.com
export LANGSMITH_PROJECT=openclaw         # optional, default: "default"
export LANGSMITH_TRACING_V2=true          # required by LangSmith SDK
```

Add these to the `.env` file used by docker-compose on the VM (see
[GCP VM deployment](/install/docker)).

### 2. Enable in openclaw.yml

The extension is auto-discovered from `extensions/langsmith-tracer/` (bundled in
the fork). You can explicitly enable it or configure the project name via config:

```yaml
plugins:
  entries:
    langsmith-tracer:
      enabled: true
      config:
        project: "openclaw-prod" # overrides LANGSMITH_PROJECT
        # endpoint: "https://..."      # overrides LANGSMITH_ENDPOINT
```

If `LANGSMITH_API_KEY` is not set the plugin logs one info line and registers no
hooks — zero overhead, no change to agent behavior.

---

## Troubleshooting

**Traces not appearing in LangSmith**

- Verify `LANGSMITH_API_KEY` is set in the container: `docker exec <container> printenv LANGSMITH_API_KEY`
- Verify `LANGSMITH_TRACING_V2=true` is set
- Check gateway logs for `langsmith-tracer:` lines (enabled/disabled message on startup, any `warn` lines)
- Make sure the project name matches what you see in smith.langchain.com

**All runs show as errors**

- Look for `agent_end` with `success: false` — check the `error` field in the LangSmith run
- The gateway logs will show the same error

**LLM runs have no token usage**

- The `llm_output` hook receives `usage` from pi-agent-core. If the model/provider
  does not report usage, the field will be empty — this is expected.

---

## Extending

To add more data to traces, edit `src/tracer.ts`. Each hook method receives the
full event object from `src/plugins/types.ts` — refer to that file for all
available fields.

To add a new hook (e.g. `before_compaction`):

1. Add a method to `LangSmithTracer` in `src/tracer.ts`
2. Register it with `api.on("before_compaction", ...)` in `index.ts`
3. Add a test case to `index.test.ts`

---

## Source layout

```
extensions/langsmith-tracer/
  index.ts           ← plugin entry point; registers all hooks
  src/
    config.ts        ← env var + plugin config resolution; Client factory
    tracer.ts        ← LangSmithTracer class (RunTree state machine)
  index.test.ts      ← unit tests (no network required)
  README.md          ← this file
  package.json       ← dep: langsmith@^0.5
```

---

## Key reference files

- Plugin hook types and event shapes: [src/plugins/types.ts](../../src/plugins/types.ts)
- Hook call sites in the agent loop: [src/agents/pi-embedded-runner/run/attempt.ts](../../src/agents/pi-embedded-runner/run/attempt.ts)
- Best example of a hooks-based extension: [extensions/memory-lancedb/](../memory-lancedb/)
- Fork scope and deploy plan: [docs/reference/fork-and-deploy-plan.md](../../docs/reference/fork-and-deploy-plan.md)
- LangSmith RunTree API: `langsmith/run_trees` (see `node_modules/langsmith/dist/run_trees.d.ts`)
