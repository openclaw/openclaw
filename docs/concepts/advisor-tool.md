---
summary: "Advisor tool: let Claude consult a second model instance during inference"
read_when:
  - Enabling or configuring the advisor tool for Anthropic models
  - Debugging advisor output or token billing questions
title: "Advisor Tool"
---

# Advisor tool

The advisor tool is an Anthropic beta feature that lets the primary Claude model
consult a separate model instance mid-inference — similar to an internal
second opinion. The advisor runs as a sub-inference and its output appears
inline in the conversation as `[Advisor] ...` text.

Only works with Anthropic models. The required beta header
(`advisor-tool-2026-03-01`) is added automatically when the feature is enabled.

## Enabling the advisor

Set `advisor: true` under the model's `params` in `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-sonnet-4-6": {
          "params": {
            "advisor": true
          }
        }
      }
    }
  }
}
```

This uses the default advisor model (`claude-sonnet-4-6`).

## Custom advisor model

Pass an object to specify a different advisor model:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-sonnet-4-6": {
          "params": {
            "advisor": {
              "enabled": true,
              "model": "claude-sonnet-4-5"
            }
          }
        }
      }
    }
  }
}
```

## Configuration options

| Field             | Type      | Description                                                   |
| ----------------- | --------- | ------------------------------------------------------------- |
| `advisor`         | `boolean` | Shorthand. `true` enables the advisor with the default model. |
| `advisor.enabled` | `boolean` | Enable or disable the advisor.                                |
| `advisor.model`   | `string`  | Advisor model ID. Defaults to `claude-sonnet-4-6`.            |

## What the user sees

When the advisor weighs in, its output is prepended to the response as
`[Advisor] ...`. The primary model can then incorporate that input into its
final reply.

## Notes

- **Beta feature.** The `advisor-tool-2026-03-01` beta header is required and
  is added automatically — no manual header configuration needed.
- **Anthropic only.** The advisor tool has no effect on non-Anthropic providers.
- **Separate token costs.** The advisor sub-inference has its own input/output
  token usage, billed independently from the primary inference.
- **Multi-turn round-tripping.** All server-side tool blocks (including
  advisor results and encrypted content) are preserved in conversation history
  and sent back to the API on subsequent turns. The round-trip path uses
  `opaqueServerBlock` storage which bypasses the pi-ai type system via cast —
  if pi-ai ever adds strict runtime validation on content block types, an
  upstream type extension may be needed.

## Related

- [Model Providers](/concepts/model-providers) — provider routing and auth
- [Models CLI](/concepts/models) — model configuration and aliases
