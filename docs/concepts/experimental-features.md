---
summary: "What experimental flags mean in OpenClaw and which ones are currently documented"
title: "Experimental features"
read_when:
  - You see an `.experimental` config key and want to know whether it is stable
  - You want to try preview runtime features without confusing them with normal defaults
  - You want one place to find the currently documented experimental flags
---

Experimental features are opt-in preview surfaces behind explicit flags. They need more real-world mileage before they get a stable default or a long-lived contract.

- Off by default unless a doc tells you to enable one.
- Shape and behavior can change faster than stable config.
- Prefer a stable path when one already exists.
- Roll out broadly only after testing in a smaller environment first.

## Currently documented flags

| Surface                  | Key                                                                                        | Use it when                                                                                                                       | More                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Local model runtime      | `agents.defaults.experimental.localModelLean`, `agents.list[].experimental.localModelLean` | A smaller or stricter local backend chokes on OpenClaw's full default tool surface                                                | [Local Models](/gateway/local-models)                                                         |
| Memory search            | `agents.defaults.memorySearch.experimental.sessionMemory`                                  | You want `memory_search` to index prior session transcripts and accept the extra storage/indexing cost                            | [Memory configuration reference](/reference/memory-config#session-memory-search-experimental) |
| Codex harness            | `plugins.entries.codex.config.appServer.experimental.sandboxExecServer`                    | You want native Codex app-server 0.132.0 or newer to target an OpenClaw sandbox-backed exec-server instead of disabling Code Mode | [Codex harness reference](/plugins/codex-harness-reference#sandboxed-native-execution)        |
| Structured planning tool | `tools.experimental.planTool`                                                              | You want the structured `update_plan` tool exposed for multi-step work tracking in compatible runtimes and UIs                    | [Gateway configuration reference](/gateway/config-tools#toolsexperimental)                    |

## Local model lean mode

`agents.defaults.experimental.localModelLean: true` drops three default tools - `browser`, `cron`, and `message` - from the agent's tool surface every turn. It also defaults to structured Tool Search (`tool_search`, `tool_describe`, `tool_call`) for plugin/MCP/client tool catalogs when `tools.toolSearch` is not already set, so those catalogs stay off the prompt instead of being dumped in. Runs that require direct `message` delivery keep it direct rather than picking up the lean-mode Tool Search default. Use `agents.list[].experimental.localModelLean` to scope this to one agent.

If you already tune Tool Search globally, OpenClaw leaves that config alone. Set `tools.toolSearch: false` to opt out of the lean-mode Tool Search default.

### Why these three tools

`browser`, `cron`, and `message` have the largest descriptions and most parameter shapes in the default runtime. On a small-context or stricter OpenAI-compatible backend, that is the difference between:

- Tool schemas fitting the prompt vs. crowding out conversation history.
- The model picking the right tool vs. emitting malformed tool calls from too many similar schemas.
- The Chat Completions adapter staying inside structured-output limits vs. a 400 on tool-call payload size.

Removing them only shortens the direct tool list. The model still has `read`, `write`, `edit`, `exec`, `apply_patch`, web search/fetch (when configured), memory, and session/agent tools. Extra catalogs stay reachable through Tool Search unless you set `tools.toolSearch: false`.

### When to turn it on

Enable lean mode once you have proved the model can talk to the Gateway but full agent turns misbehave:

1. `openclaw infer model run --gateway --model <ref> --prompt "Reply with exactly: pong"` succeeds.
2. A normal agent turn fails with malformed tool calls, oversized prompts, or the model ignoring its tools.
3. Toggling `localModelLean: true` clears the failure.

### When to leave it off

If your backend handles the full default runtime cleanly, leave this off. It is a workaround for local stacks that need a smaller tool surface, not a default for hosted models or well-resourced local rigs.

Lean mode does not replace `tools.profile`, `tools.allow`/`tools.deny`, or the model `compat.supportsTools: false` escape hatch. For a permanent narrower tool surface on a specific agent, prefer those stable knobs.

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

For one agent only:

```json5
{
  agents: {
    list: [
      {
        id: "local",
        model: "lmstudio/gemma-4-e4b-it",
        experimental: {
          localModelLean: true,
        },
      },
    ],
  },
}
```

Restart the Gateway after changing the flag.

## Experimental does not mean hidden

An experimental feature should say so plainly in docs and in the config path itself, not hide behind a stable-looking default knob.

## Related

- [Features](/concepts/features)
- [Release channels](/install/development-channels)
