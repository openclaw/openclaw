---
summary: "Route between local and remote models per intent (tiered + hybrid planner->executor)"
read_when:
  - You want to use local models for low-risk work, and a stronger remote model for higher-risk work
  - You want a hybrid flow: remote planner writes a spec, local model executes with tools
  - You’re tuning per-intent model selection for conversations vs periodic jobs (heartbeats)
---
# Model Routing

Clawdbrain can optionally route between models *by intent* (not per-message classification) so
conversations stay stable while still letting you use different local models for different workflows.

This is configured under:

- `agents.defaults.modelRouting`

## Why model routing exists

Model routing is designed to support:

- **Stable conversations**: pick a model for a workflow (intent) instead of re-classifying each message.
- **Local-first execution**: use local models for tasks that are verifiable/low-stakes.
- **Hybrid safety**: use a strong remote model to write a short execution spec, then let a local model execute it.

## Tiers

Tiers are just named slots that point at models (provider/model or alias):

- `local-small` (e.g. 3-8B)
- `local-large` (e.g. ~30B)
- `remote` (your SOTA model)

You bind tiers with:

- `agents.defaults.modelRouting.models.localSmall`
- `agents.defaults.modelRouting.models.localLarge`
- `agents.defaults.modelRouting.models.remote`
- `agents.defaults.modelRouting.models.planner` (used for hybrid mode)

## Intents (where routing applies)

Routing is applied in a few key places:

- `cli.agent`: the `clawdbrain agent ...` command (CLI)
- `message.reply`: normal message replies (conversation path)
- `heartbeat`: heartbeat runs / periodic agent checks

You can override routing per intent in:

- `agents.defaults.modelRouting.intents`

## Modes

Each intent can run in one of these modes:

- `off`: no routing; use normal model selection (`agents.defaults.model`, session overrides, etc.)
- `tiered`: pick a single tier model for the whole run
- `hybrid`: run a **planner** model first (LLM-only), then run an **executor** model with tools

### Hybrid flow (planner -> executor)

In hybrid mode:

1) The planner model runs with **tools disabled** and returns a compact JSON spec.
2) That JSON spec is injected into the executor run as **system prompt guidance**.
3) The executor model runs normally (tools allowed) and follows the spec.

This is meant for workflows like:

- periodic tasks (heartbeats)
- tool-heavy but verifiable tasks (repo scanning, log digestion, status checks)

## Interaction with /model and session overrides

Routing is designed to avoid “flapping” and surprising model switches:

- If a user explicitly uses `/model ...` for that turn, routing does **not** override it.
- By default, routing also respects stored session model overrides.
- If you set `respectSessionOverride: false` for an intent, routing will override stored session model overrides for that run.

## Configuration reference

Minimal example (aliases + hybrid heartbeat):

```json5
{
  agents: {
    defaults: {
      // Allowlist + aliases
      models: {
        "ollama/llama3:8b": { alias: "local8b" },
        "ollama/qwen2.5:32b": { alias: "local30b" }
      },

      modelRouting: {
        enabled: true,
        models: {
          localSmall: "local8b",
          localLarge: "local30b",
          remote: "anthropic/claude-sonnet-4-5",
          planner: "anthropic/claude-opus-4-5"
        },

        // Used when an intent doesn't override anything
        defaultPolicy: {
          mode: "tiered",
          tier: "remote"
        },

        intents: {
          heartbeat: {
            mode: "hybrid",
            executorTier: "local-large",
            stakes: "low",
            verifiability: "high",
            maxToolCalls: 8,
            allowWriteTools: false
          }
        }
      }
    }
  }
}
```

Policy fields you can set per intent:

- `mode`: `off | tiered | hybrid`
- `tier`: `local-small | local-large | remote` (tiered)
- `executorTier`: `local-small | local-large | remote` (hybrid)
- `plannerModel`: explicit planner model override (provider/model or alias)
- `executorModel`: explicit executor model override (provider/model or alias)
- `stakes`: `low | medium | high`
- `verifiability`: `low | medium | high`
- `maxToolCalls`: numeric hint passed to planner (hybrid)
- `allowWriteTools`: boolean hint passed to planner (hybrid)
- `respectSessionOverride`: default `true`

## Limitations (important)

- **CCSDK runtime** (`agents.defaults.runtime: "ccsdk"`) ignores provider/model selection. Model routing is only applied when the Pi runtime is in use.
- `maxToolCalls` and `allowWriteTools` are currently **prompt-level constraints** (not hard enforcement).
  If you need hard enforcement, pair routing with tool policy/allowlists.

## Related docs

- [/concepts/models](/concepts/models)
- [/concepts/model-failover](/concepts/model-failover)
- [/concepts/agent-loop](/concepts/agent-loop)

