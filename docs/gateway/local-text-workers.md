---
summary: "Pattern: cloud model orchestrates and uses tools; local models do bounded text-only work"
read_when:
  - You want a cloud model to coordinate tools while local models handle drafts or summaries
  - You are mixing hosted and local models and need the local model to stay text-only
  - You need timeout and sandbox guidance for local worker models
title: "Local text workers"
---

Use a strong hosted model as the **orchestrator** when a task needs tool use,
file edits, browser control, channel delivery, or multi-step judgment. Use local
models as **bounded text workers** for tasks where the input and output are plain
text or JSON: drafting, summarizing, rewriting, extracting labels, or proposing
small edits for the orchestrator to review.

This pattern keeps tool execution with the hosted orchestrator that is most
reliable at planning and tool calling, while still using local capacity for
private, repeatable text work.

## Use this pattern when

- The local model is good at text transformation but unreliable at autonomous
  tool use.
- You want to keep source text, drafts, or summaries on local hardware.
- The task can be checked by the cloud orchestrator before anything is written,
  sent, scheduled, or executed.
- A local model is useful as a fallback or worker, but not trusted as the main
  agent for the whole run.

Do not use this pattern to hide a task that really needs tools. If the worker
must inspect files, call APIs, browse, send messages, or run commands, keep that
work with the orchestrator or create a separate sandboxed agent with an explicit
tool policy.

## Recommended shape

1. Keep the main agent on a hosted model with the normal tool surface.
2. Configure one local model provider as described in [Local models](/gateway/local-models).
3. Delegate only bounded text tasks to the local model.
4. Require the orchestrator to review worker output before taking side effects.
5. Add timeouts so slow local generations do not stall the whole run.

The text worker should receive a narrow prompt and a small input. It should
return a draft, summary, classification, or JSON object, not instructions for
itself to execute later.

## Configure the local model

Start with a local provider that already works with a direct model probe:

```bash
openclaw infer model run --local --model local/my-local-model --prompt "Reply with exactly: pong" --json
```

Then keep the hosted model as the orchestrator and register the local model as
an available model. The provider block can be LiteLLM, LM Studio, MLX, Ollama,
vLLM, or another OpenAI-compatible server.

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Orchestrator" },
        "local/my-local-model": { alias: "Local Worker" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "local-model",
        api: "openai-completions",
        timeoutSeconds: 300,
        models: [
          {
            id: "my-local-model",
            name: "Local Worker",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
}
```

Use [Local model services](/gateway/local-model-services) if the local server
should start only when selected.

## Choose a worker path

### JSON-only tasks with llm-task

Use [LLM task](/tools/llm-task) when the worker should return structured data
and never call tools. `llm-task` runs a single JSON-only model call with tools
disabled.

```json5
{
  plugins: {
    entries: {
      "llm-task": {
        enabled: true,
        config: {
          defaultProvider: "local",
          defaultModel: "my-local-model",
          allowedModels: ["local/my-local-model"],
          timeoutMs: 60000,
        },
      },
    },
  },
  tools: {
    alsoAllow: ["llm-task"],
  },
}
```

Good text-worker prompts:

- "Summarize this issue body into problem, impact, and acceptance criteria."
- "Return JSON with `intent`, `risk`, and `recommended_next_step`."
- "Rewrite this draft to be shorter and preserve every factual claim."

Avoid prompts such as "inspect the repo", "fix the bug", or "send the reply".
Those are orchestrator tasks because they need tools or side effects.

### Native sub-agents with a local model

Use [Sub-agents](/tools/subagents) when the worker needs its own agent run,
status tracking, and announce-back behavior. Native sub-agents are not
text-only by default: they inherit model and tool policy, then OpenClaw applies
the sub-agent restriction layer. Treat them as local text workers only after
you have narrowed their tools to the text-safe surface they actually need.
Prefer `llm-task` when you only need a strict text or JSON worker response.

Set a cheaper or local model for sub-agents and keep the task prompt explicit:

```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "local/my-local-model",
        runTimeoutSeconds: 900,
      },
    },
  },
}
```

If the local worker should stay text-only, either prefer `llm-task`, or narrow
the sub-agent tool surface with `tools.subagents.tools.allow` so the worker
cannot reach side-effecting tools. That allowlist is a final filter, so choose
an agent tool profile that already includes the harmless tools the worker needs
before narrowing it. The parent orchestrator should still verify the result
before applying it.

### CLI backends as text fallback

Use [CLI backends](/gateway/cli-backends) when the local worker is an external
AI CLI. CLI backends are text-oriented by default and do not receive OpenClaw
tools directly. A backend can see gateway tools only when its owning plugin
supports and enables `bundleMcp: true`.

For a text worker, keep `bundleMcp` off or omitted and treat the CLI output as a
draft for the orchestrator to review.

## Keep tools with the orchestrator

The orchestrator should own:

- file reads and writes
- shell commands
- browser actions
- channel delivery and replies
- credentials, auth, and provider routing
- final approval of worker output

The local worker should own:

- summaries
- drafts
- classifications
- text normalization
- JSON extraction
- small refactoring suggestions that the orchestrator applies

This split makes failure easier to reason about: bad worker output is just text
until the orchestrator chooses to act on it.

## Timeouts and local servers

Local models can cold-load slowly or stream for a long time. Set timeouts at the
surface that owns the wait:

| Surface                        | Timeout knob                                        |
| ------------------------------ | --------------------------------------------------- |
| Local provider request         | `models.providers.<id>.timeoutSeconds`              |
| On-demand local server startup | `models.providers.<id>.localService.readyTimeoutMs` |
| Native sub-agent run           | `agents.defaults.subagents.runTimeoutSeconds`       |
| `llm-task` plugin call         | `plugins.entries.llm-task.config.timeoutMs`         |

Keep the worker prompt short enough that a timeout points to a real local model
problem, not an oversized orchestration request that should stay with the
hosted orchestrator.

## Sandbox and side effects

A text-only model call does not run tools, so sandboxing is not the main safety
control. The important control is that worker output remains data until the
orchestrator reviews it.

If you let a local-model sub-agent use tools, apply the normal [Sandboxing](/gateway/sandboxing)
and [Multi-agent sandbox tools](/tools/multi-agent-sandbox-tools) controls:

- use per-agent or sub-agent tool allowlists;
- deny side-effecting tools unless the worker truly needs them;
- sandbox non-main or worker sessions when file or process access is possible;
- require the orchestrator to make the final write, send, or command decision.

## Test the setup

1. Prove the local model transport:

   ```bash
   openclaw infer model run --local --model local/my-local-model --prompt "Reply with exactly: pong" --json
   ```

2. Prove gateway routing without tools:

   ```bash
   openclaw infer model run --gateway --model local/my-local-model --prompt "Reply with exactly: pong" --json
   ```

3. Run one worker-style prompt and confirm the result is text or JSON only.
4. Ask the main hosted agent to review that output before taking any action.

Use synthetic or redacted task text for these probes; do not paste credentials
or production secrets into local-worker prompts.

If direct probes pass but full agent turns fail, use [Local models](/gateway/local-models#smaller-or-stricter-backends)
to reduce tool pressure with lean mode or model compatibility settings.

## Troubleshooting

| Symptom                                    | Check                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Worker tries to call tools as text         | Keep the task text-only, use `llm-task`, or disable tool support for that model in local model config. |
| Local server is slow to start              | Use `localService.readyTimeoutMs` and keep the model warm for frequent work.                           |
| Sub-agent can see more tools than expected | Inspect the effective tool policy and narrow with `tools.subagents.tools.allow`.                       |
| Orchestrator trusts a bad draft            | Add an explicit review step before write/send/exec actions.                                            |
| Full local agent turns are unstable        | Keep the hosted model as primary and delegate only bounded text work.                                  |

## Related

- [Local models](/gateway/local-models)
- [Local model services](/gateway/local-model-services)
- [CLI backends](/gateway/cli-backends)
- [LLM task](/tools/llm-task)
- [Sub-agents](/tools/subagents)
- [Sandboxing](/gateway/sandboxing)
