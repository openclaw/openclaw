# Memory (Memoria)

`memory-memoria` is a bundled OpenClaw `kind: "memory"` extension backed by Memoria.

## Status

- HTTP mode is first-class (`backend: "http"`).
- Embedded mode is advanced (`backend: "embedded"`) and currently requires a user-managed Python runtime + Memoria dependencies.
- OpenClaw core does not bootstrap Python environments for plugins.

## Enable

```json5
{
  plugins: {
    slots: {
      memory: "memory-memoria",
    },
    entries: {
      "memory-memoria": {
        enabled: true,
        config: {
          backend: "http",
          apiUrl: "http://127.0.0.1:8100",
          apiKey: "${MEMORIA_API_KEY}",
          defaultUserId: "openclaw-user",
          userIdStrategy: "sessionKey",
          autoRecall: true,
          autoObserve: false,
          retrieveTopK: 5
        }
      }
    }
  }
}
```

## Tools

The plugin registers these tools:

- `memory_search`
- `memory_get`
- `memory_store`
- `memory_retrieve`
- `memory_recall` (alias of `memory_retrieve`)
- `memory_forget`
- `memory_list`
- `memory_stats`

## Hooks

- `before_prompt_build`: appends Memoria guidance and injects auto-recall context when enabled.
- `agent_end`: optional auto-observe capture from recent user messages.

## Embedded mode expectations

If you set `backend: "embedded"`, provide at least:

- `pythonExecutable`
- `dbUrl`
- Memoria Python dependencies in that Python runtime

If these are not available, tool calls return an actionable runtime error.
