# Advisor Plugin

Advisor adds an `advisor` tool to OpenClaw agents. The tool asks an LLM for a
focused second opinion on a plan, implementation, review, or design tradeoff.

Use it when the agent needs another read before doing something risky or
ambiguous:

- review a complex plan before execution
- check edge cases in a proposed implementation
- get a second opinion on requirements or architecture choices
- flag likely security issues, side effects, or unsafe assumptions

## Configuration

By default the tool uses the agent's active model. To route advisor calls to a
specific model, configure `modelRef` and allow model override for this plugin:

```json
{
  "plugins": {
    "entries": {
      "advisor": {
        "enabled": true,
        "config": {
          "modelRef": "lmstudio/google/gemma-4-12b"
        },
        "llm": {
          "allowModelOverride": true
        }
      }
    }
  },
  "tools": {
    "alsoAllow": ["advisor"]
  }
}
```

The advisor only sees the `question` and optional `context` passed into the
tool call, so include the relevant code, constraints, and current conclusion in
the request.

## Tool

`advisor`

- `question` - required question, problem, or decision for review.
- `context` - optional background, code snippets, constraints, or prior
  conclusions.
