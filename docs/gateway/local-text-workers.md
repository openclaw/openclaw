---
summary: "Pattern: cloud model orchestrates and uses tools; local models do bounded text-only work"
read_when:
  - You want a cloud model to coordinate tools while local models draft or summarize
  - You are mixing hosted and local models and want a safe delegation pattern
  - You need to avoid assuming local models can call tools autonomously
title: "Local text workers"
---

Use a cloud orchestrator plus local text workers when you want the main agent to keep reliable tool use while cheaper or private local models handle bounded text work. The cloud model owns planning, tool calls, approvals, and final decisions. Local models act as workers for drafting, summarizing, rewriting, or classifying text.

This is a composition of existing OpenClaw surfaces, not a separate runtime mode.

## Recommended shape

Keep the orchestrator on a hosted model with the full tool surface:

- run the main agent on a model that reliably follows OpenClaw tool schemas;
- use local models only for prompt-in, text-out tasks;
- validate local output before passing it to side-effecting tools;
- set explicit timeouts for slower local servers.

Use this pattern when a task can be framed as: "Given this text, return revised text or JSON." Do not use it when the worker must browse, execute commands, call channel tools, or make approval decisions.

## Worker options

| Worker surface | Best fit | Tool expectation |
| -------------- | -------- | ---------------- |
| [LLM task](/tools/llm-task) | JSON-only workflow steps with schema validation | No tools |
| [Sub-agents](/tools/subagents) | Background drafting, review, or summarization that can be checked by the parent | Depends on the child agent tool policy; keep local workers narrow |
| [CLI backends](/gateway/cli-backends) | Local AI CLI fallback for text responses | Text-only unless the backend opts into bundled MCP |
| [Local models](/gateway/local-models) | LM Studio, Ollama, vLLM, LiteLLM, or custom OpenAI-compatible servers | Model-dependent; disable tools when the backend emits unreliable tool text |

For the lowest-risk setup, use `llm-task` for structured text transforms and keep sub-agents or CLI backends for longer human-readable drafting.

## Configure local models as workers

Keep hosted models available and add the local provider with `models.mode: "merge"`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "lmstudio/my-local-model": { alias: "Local worker" },
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
            name: "Local Worker",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
            compat: {
              supportsTools: false,
            },
          },
        ],
      },
    },
  },
}
```

`compat.supportsTools: false` is the conservative setting for local workers that should never attempt OpenClaw tool calls. Remove it only after the backend's tool-call behavior is verified for real agent turns. See [Local models](/gateway/local-models#smaller-or-stricter-backends) for the step-by-step transport checks and lean-mode fallback.

## Delegate bounded work

For structured workflow steps, enable `llm-task` and constrain its allowed model list:

```json5
{
  plugins: {
    entries: {
      "llm-task": {
        enabled: true,
        config: {
          defaultProvider: "lmstudio",
          defaultModel: "my-local-model",
          allowedModels: ["lmstudio/my-local-model"],
          maxTokens: 800,
          timeoutMs: 30000,
        },
      },
    },
  },
  tools: {
    alsoAllow: ["llm-task"],
  },
}
```

Ask the worker for a small result, then let the orchestrator inspect it before acting:

```text
Summarize the following incident notes into JSON with keys: summary, risks, next_steps.
Do not call tools. Return only JSON.
```

For longer drafting or review work, configure a child agent on the local model and spawn it as a sub-agent. Keep that child on a narrow tool profile or no tools, and have the parent verify the result before using it.

## Timeouts and sandboxing

Local models are often slower than hosted APIs. Set provider-level `timeoutSeconds` for model HTTP calls and raise `agents.defaults.timeoutSeconds` only when the whole agent run needs more time. For background worker patterns, set `agents.defaults.subagents.runTimeoutSeconds` so a slow local child cannot run forever.

If a worker can execute commands, require sandboxing and keep its tool surface narrow. If it only returns text, prefer `llm-task` or `compat.supportsTools: false` so the worker cannot turn text into tool execution by accident.

## Common mistakes

- Expecting a local model to call tools autonomously without first verifying its tool parser.
- Letting a local worker make irreversible decisions instead of returning draft text for the orchestrator to check.
- Sending huge transcripts to a smaller local model and then treating truncated summaries as authoritative.
- Raising global agent timeouts when only one local provider needs more time.

## Related

- [Local models](/gateway/local-models)
- [CLI backends](/gateway/cli-backends)
- [Sub-agents](/tools/subagents)
- [LLM task](/tools/llm-task)
- [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools)
