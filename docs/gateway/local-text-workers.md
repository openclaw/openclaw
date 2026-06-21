---
summary: "Pattern: cloud model orchestrates and uses tools; local models do bounded text-only work"
read_when:
  - You run a mixed cloud plus local deployment
  - You want a cloud model to drive tools while local models draft or summarize
  - Local-model tool calling is less reliable than your cloud model
title: "Local text workers"
sidebarTitle: "Local text workers"
---

A common, pragmatic setup for mixed deployments: keep a strong **cloud model as the
orchestrator** that does real tool use, and use **local models as bounded
text-in/text-out workers** for drafting, refactoring, summarization, and other
narrow text tasks.

This page composes existing guidance into one workflow. It adds no new runtime
behavior or config. Everything here is built from
[Local models](/gateway/local-models), [Sub-agents](/tools/subagents),
[CLI backends](/gateway/cli-backends), and the optional
[LLM task](/tools/llm-task) tool.

## When to use this pattern

Use local models as delegated text workers when:

- Your cloud model handles orchestration and tool calls reliably, but local
  tool calling on your stack is inconsistent (raw JSON/XML/ReAct text instead of
  real tool invocations — see [Local models](/gateway/local-models#smaller-or-stricter-backends)).
- The delegated work is bounded and text-shaped: draft this reply, summarize
  this transcript, rewrite this paragraph, extract fields from this text.
- You want to spend cloud tokens on planning and tools, and offload high-volume
  or repetitive text generation to a local box.

Do **not** expect a local model to run OpenClaw tools autonomously unless you
have configured and verified tool calling for that exact model and server. Frame
local workers as text-only helpers by default.

## How the pieces fit

| Role             | Who does it                                                                      | Surface                                                       |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Orchestrator     | Cloud model with tools                                                           | `agents.defaults.model.primary`                               |
| Delegated worker | Local model (restricted sub-agent, no-tool `llm-task`, or text-only CLI backend) | sub-agent model override, `llm-task`, or a CLI backend        |
| Safety net       | Cloud fallback when the local box is down                                        | `agents.defaults.model.fallbacks` with `models.mode: "merge"` |

## Step 1: cloud orchestrator, local provider registered

Keep a tool-capable cloud model as the primary and register your local provider
so it is available to workers. Use `models.mode: "merge"` so hosted models stay
available as fallbacks.

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: ["anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "lmstudio/my-local-model": { alias: "Local" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        timeoutSeconds: 300,
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

See [Local models](/gateway/local-models) for backend selection, the hardware
floor, and OpenAI-compatible proxy variants. Use
`models.providers.<id>.timeoutSeconds` for slow local servers before raising
`agents.defaults.timeoutSeconds`; the provider timeout only covers model HTTP
requests and cannot extend the whole agent run.

## Step 2: pick a delegation surface

Choose the worker surface that matches how much structure you need.

### Sub-agents with a cheaper local model

Set a cheaper model for sub-agents while the main agent stays on the cloud model.
Native sub-agents inherit the caller model unless you set
`agents.defaults.subagents.model` (or per-agent
`agents.list[].subagents.model`).

Native sub-agents are **not** text-only by default. They run the same
tool-policy pipeline as the parent or target agent, so with no restrictive
`tools.profile` a sub-agent receives every tool except the message, session, and
system tools — including `read`, `exec`, and `web_*`. Pointing a sub-agent at a
local model does not make it text-only; it just changes the model behind that
tool-capable worker. To narrow a local worker, set an allow-only filter with
`tools.subagents.tools.allow` (deny still wins, and an allow list cannot add back
a tool removed by `tools.profile`):

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      subagents: {
        // Object form keeps the cloud safety net: list fallbacks explicitly. A bare
        // string model (e.g. "lmstudio/my-local-model") opts out of the global
        // agents.defaults.model.fallbacks and resolves to no fallbacks, so the worker
        // would have no cloud backup if the local box is down.
        model: {
          primary: "lmstudio/my-local-model",
          fallbacks: ["anthropic/claude-sonnet-4-6"],
        },
        runTimeoutSeconds: 900, // 0 = no timeout
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // allow-only: restrict the local worker to a minimal tool set
        allow: ["read"],
      },
    },
  },
}
```

If you want a guaranteed no-tool text worker, prefer
[LLM task](#llm-task-for-schema-validated-text-steps) below — it is JSON-only and
exposes no tools to the model. A [CLI backend](#cli-backend-as-a-text-only-fallback)
also gets no direct OpenClaw tool injection, but only stays no-tool while
`bundleMcp` is off (see below).

Brief the child fully in the task text, because isolated sub-agents start with a
clean transcript. See [Sub-agents](/tools/subagents) for context modes,
completion delivery, and tool policy. If a child genuinely needs the requester
transcript, the agent can request `context: "fork"` on that one spawn.

### LLM task for schema-validated text steps

For a single bounded text step that returns structured output, the optional
[LLM task](/tools/llm-task) tool is JSON-only and exposes **no tools** to the
model. Pin it to a local model and constrain it with `allowedModels`.

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "lmstudio",
          "defaultModel": "my-local-model",
          "allowedModels": ["lmstudio/my-local-model"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  },
  "tools": {
    "alsoAllow": ["llm-task"]
  }
}
```

Treat the output as untrusted unless you validate it with a `schema`, and keep
approvals before any side-effecting step.

### CLI backend as a text-only fallback

If you already run a local AI CLI, a [CLI backend](/gateway/cli-backends) is a
**text-only fallback**: OpenClaw tools are not injected into the CLI protocol
directly. One exception — a backend with `bundleMcp: true` opts into a loopback
MCP bridge that does expose gateway tools to the CLI process (see
[Bundle MCP overlays](/gateway/cli-backends#bundle-mcp-overlays)). Leave
`bundleMcp` off to keep this surface a plain text path.

## Step 3: keep local tool expectations honest

Treat local workers as text-only: even when a tool-capable surface exposes tools
to them, local models often emit tool-call-looking text instead of real tool
calls. When that happens, tighten the local surface rather than expecting
autonomous tool use:

- Enable `agents.defaults.experimental.localModelLean: true` to drop the heaviest
  default tools and route larger catalogs behind Tool Search. See
  [Local model lean mode](/concepts/experimental-features#local-model-lean-mode).
- As a last resort, set
  `models.providers.<provider>.models[].compat.supportsTools: false` for that
  model entry so the agent operates without tool calls on it.

## Sandbox and timeout considerations

- **Sandbox:** sub-agents are isolated by default and support optional
  sandboxing. Require it for delegated runs with `sandbox: "require"` on the
  spawn, which rejects spawns whose child runtime is not sandboxed. A sandboxed
  requester already rejects unsandboxed targets.
- **Run timeout:** local models run slower. OpenClaw uses
  `agents.defaults.subagents.runTimeoutSeconds` when set, otherwise `0` (no
  timeout). `sessions_spawn` does not accept per-call timeout overrides.
- **Provider timeout:** raise `models.providers.<id>.timeoutSeconds` for slow
  local servers, and raise the agent or run timeout too if it is lower, because
  provider timeouts cannot extend the whole agent run.
- **Safety:** local models skip provider-side filters. Keep delegated workers
  narrow, text-only, and with compaction on to limit prompt-injection blast
  radius.

## Related

- [Local models](/gateway/local-models)
- [Sub-agents](/tools/subagents)
- [CLI backends](/gateway/cli-backends)
- [LLM task](/tools/llm-task)
- [Model failover](/concepts/model-failover)
