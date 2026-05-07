---
summary: "What experimental flags mean in OpenClaw and which ones are currently documented"
title: "Experimental features"
read_when:
  - You see an `.experimental` config key and want to know whether it is stable
  - You want to try preview runtime features without confusing them with normal defaults
  - You want one place to find the currently documented experimental flags
---

Experimental features in OpenClaw are **opt-in preview surfaces**. They are
behind explicit flags because they still need real-world mileage before they
deserve a stable default or a long-lived public contract.

Treat them differently from normal config:

- Keep them **off by default** unless the related doc tells you to try one.
- Expect **shape and behavior to change** faster than stable config.
- Prefer the stable path first when one already exists.
- If you are rolling OpenClaw out broadly, test experimental flags in a smaller
  environment before baking them into a shared baseline.

## Currently documented flags

| Surface                         | Key                                                       | Use it when                                                                                                    | More                                                                                          |
| ------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Local model runtime             | `agents.defaults.experimental.localModelLean`             | A smaller or stricter local backend chokes on OpenClaw's full default tool surface                             | [Local Models](/gateway/local-models)                                                         |
| Agent command runtime isolation | `agents.defaults.experimental.runtimeIsolation`           | You want `/agent` command attempts to run in a Node worker compartment while testing parallel-agent isolation  | [Agent command runtime isolation](#agent-command-runtime-isolation)                           |
| Memory search                   | `agents.defaults.memorySearch.experimental.sessionMemory` | You want `memory_search` to index prior session transcripts and accept the extra storage/indexing cost         | [Memory configuration reference](/reference/memory-config#session-memory-search-experimental) |
| Structured planning tool        | `tools.experimental.planTool`                             | You want the structured `update_plan` tool exposed for multi-step work tracking in compatible runtimes and UIs | [Gateway configuration reference](/gateway/config-tools#toolsexperimental)                    |

## Agent command runtime isolation

`agents.defaults.experimental.runtimeIsolation.mode: "worker"` runs `/agent`
command attempts in a Node worker thread. The parent process still owns command
routing, model fallback policy, final session-store updates, delivery, and
lifecycle reporting; the worker owns the in-repo command runtime attempt itself.

Normal inbound Gateway replies remain on the in-process embedded runner for now.
That path owns live streaming and delivery callbacks in the parent process and
needs a dedicated callback bridge before it can move into this worker
compartment.

This is a compartment boundary, not a general speed switch. It can help when
several in-repo command agents run at once and you want each run to have its own
event loop, worker lifetime, and future filesystem permission scope. It will not
make remote model calls faster, and CLI/ACP harnesses such as Codex may still
spawn their own child processes inside the worker.

Session-store writes still go through the normal `updateSessionStore(...)` path.
That writer uses a `sessions.json.lock` file lock so worker-thread updates for
different agents do not overwrite each other when they share the same store.

### Enable

```json5
{
  agents: {
    defaults: {
      experimental: {
        runtimeIsolation: {
          mode: "worker",
        },
      },
    },
  },
}
```

For developer-only overrides, `OPENCLAW_AGENT_RUNTIME_WORKER=1` forces the
worker path and `OPENCLAW_AGENT_RUNTIME_WORKER=0` forces the in-process path.
The older `OPENCLAW_AGENT_WORKER_EXPERIMENT` env var is also accepted while the
experiment is in flight.

### Worker permissions

`runtimeIsolation.permissions: true` also starts the worker with Node permission
flags scoped to the agent workspace, agent directory, session transcript,
session store and lock files, OpenClaw runtime bundle/development source,
bundled plugin source, and runtime dependencies.

Keep this off unless you are explicitly testing filesystem hardening. Node
permission behavior is stricter and more runtime-sensitive than worker
isolation itself, so package reads or child-process based harnesses may need
additional design before this becomes broadly usable.

## Local model lean mode

`agents.defaults.experimental.localModelLean: true` is a pressure-release valve for weaker local-model setups. When it is on, OpenClaw drops three default tools — `browser`, `cron`, and `message` — from the agent's tool surface for every turn. Nothing else changes.

### Why these three tools

These three tools have the largest descriptions and the most parameter shapes in the default OpenClaw runtime. On a small-context or stricter OpenAI-compatible backend that is the difference between:

- Tool schemas fitting cleanly in the prompt vs. crowding out conversation history.
- The model picking the right tool vs. emitting malformed tool calls because there are too many similar-looking schemas.
- The Chat Completions adapter staying inside the server's structured-output limits vs. tripping a 400 on tool-call payload size.

Removing them does not silently rewire OpenClaw — it just makes the tool list shorter. The model still has `read`, `write`, `edit`, `exec`, `apply_patch`, web search/fetch (when configured), memory, and session/agent tools available.

### When to turn it on

Enable lean mode when you have already proved the model can talk to the Gateway but full agent turns misbehave. The typical signal chain is:

1. `openclaw infer model run --gateway --model <ref> --prompt "Reply with exactly: pong"` succeeds.
2. A normal agent turn fails with malformed tool calls, oversized prompts, or the model ignoring its tools.
3. Toggling `localModelLean: true` clears the failure.

### When to leave it off

If your backend handles the full default runtime cleanly, leave this off. Lean mode is a workaround, not a default. It exists because some local stacks need a smaller tool surface to behave; hosted models and well-resourced local rigs do not.

Lean mode also does not replace `tools.profile`, `tools.allow`/`tools.deny`, or the model `compat.supportsTools: false` escape hatch. If you need a permanent narrower tool surface for a specific agent, prefer those stable knobs over the experimental flag.

### Enable

```json5
{
  agents: {
    defaults: {
      experimental: {
        localModelLean: true,
      },
    },
  },
}
```

Restart the Gateway after changing the flag, then confirm the trimmed tool list with:

```bash
openclaw status --deep
```

The deep status output lists the active agent tools; `browser`, `cron`, and `message` should be absent when lean mode is on.

## Experimental does not mean hidden

If a feature is experimental, OpenClaw should say so plainly in docs and in the
config path itself. What it should **not** do is smuggle preview behavior into a
stable-looking default knob and pretend that is normal. That's how config
surfaces get messy.

## Related

- [Features](/concepts/features)
- [Release channels](/install/development-channels)
