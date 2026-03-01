---
summary: "Guardrail stages, plugin configuration, and available guardrail plugins (Gray Swan, GPT-OSS-Safeguard)"
read_when:
  - Adding or tuning LLM guardrails
  - Investigating guardrail blocks
  - Configuring Gray Swan or GPT-OSS-Safeguard
title: "Guardrails"
---

# Guardrails

Guardrails run inside the OpenClaw agent loop to inspect and optionally modify or block:

- **Requests** before they reach a model
- **Tool calls** before execution
- **Tool results** before they return to the model
- **Assistant responses** before they leave the agent

Guardrails are implemented as plugins using the hook system. See [/gateway/configuration](/gateway/configuration) for config file locations.

## Stages

OpenClaw evaluates stages in this order:

1. `before_request` — inspect and optionally modify the user prompt and message history before the model call.
2. `before_tool_call` — inspect and optionally modify tool call arguments before a tool executes.
3. `after_tool_call` — inspect and optionally modify tool results before they go back to the model.
4. `after_response` — inspect and optionally modify the assistant response before it is returned.

Within a stage, hooks run by descending `priority` (higher first).
Guardrail plugins created with `createGuardrailPlugin` default to priority `50`, and you can override that with `guardrailPriority` in the plugin config.
If any hook **blocks**, later hooks do not run for that stage.

## Writing a guardrail plugin

Most guardrail plugins should use the `createGuardrailPlugin<TConfig>()` helper, which wires all four stages and handles common behaviors like `block`, `monitor`, and history inclusion.

```ts
import {
  createGuardrailPlugin,
  type GuardrailEvaluationContext,
  type GuardrailEvaluation,
} from "openclaw/plugin-sdk";

type MyGuardrailConfig = {
  failOpen?: boolean;
  stages?: {
    beforeRequest?: { enabled?: boolean; mode?: "block" | "monitor" };
    afterResponse?: { enabled?: boolean; mode?: "block" | "monitor" };
  };
};

export default createGuardrailPlugin<MyGuardrailConfig>({
  id: "my-guardrail",
  name: "My Guardrail",
  async evaluate(
    ctx: GuardrailEvaluationContext,
    _config: MyGuardrailConfig,
  ): Promise<GuardrailEvaluation | null> {
    if (ctx.content.includes("unsafe")) {
      return { safe: false, reason: "unsafe content" };
    }
    return { safe: true };
  },
  formatViolationMessage(evaluation, location) {
    return `Blocked ${location}: ${evaluation.reason ?? "unsafe content"}.`;
  },
});
```

## Advanced manual hooks

If you need full control, you can register raw hook handlers via `api.on()`:

```ts
// Example plugin registering guardrail hooks
export default {
  id: "my-guardrail",
  register(api) {
    api.on(
      "before_request",
      async (event, ctx) => {
        // event: { prompt, messages, systemPrompt? }
        // Return to block or modify:
        // { block: true, blockResponse: "..." }
        // { prompt: "modified", messages: [...] }
      },
      { priority: 50 },
    );

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        // event: { toolName, toolCallId, params, messages, systemPrompt? }
        // Return to block, modify params, or inject a synthetic result:
        // { block: true, blockReason: "..." }
        // { params: { modified: true } }
        // { syntheticResult: "cached value" }  — skips real tool execution
      },
      { priority: 50 },
    );

    api.on(
      "after_tool_call",
      async (event, ctx) => {
        // event: { toolName, toolCallId, params, result, messages, systemPrompt? }
        // Return to block or modify:
        // { block: true, result: {...} }
        // { result: modifiedResult }
      },
      { priority: 50 },
    );

    api.on(
      "after_response",
      async (event, ctx) => {
        // event: { assistantTexts, messages, lastAssistant? }
        // Return to block or modify:
        // { block: true, blockResponse: "..." }
        // { assistantTexts: ["modified"] }
      },
      { priority: 50 },
    );
  },
};
```

Each handler can return a result with:

- `block: true` to stop processing and return a guardrail response
- Modified fields (`prompt`, `messages`, `params`, `result`, `assistantTexts`) to rewrite the payload
- Nothing (or `undefined`) to allow the payload unchanged

### Stage payloads

Each stage receives a different view of the conversation:

- `before_request`: history + the current **user** prompt
- `before_tool_call`: history + a synthetic **assistant** message that summarizes the tool call
- `after_tool_call`: history + a synthetic **tool** message that contains the tool result text
- `after_response`: history + the final **assistant** response text

## Built-in guardrail plugins

### Gray Swan

Gray Swan guardrails use the [Gray Swan Cygnal API for OpenClaw](https://platform.grayswan.ai/openclaw) for content moderation.

Configuration example:

```json
{
  "plugins": {
    "entries": {
      "grayswan-cygnal-guardrail": {
        "enabled": true,
        "config": {
          "apiKey": "${GRAYSWAN_API_KEY}",
          "apiBase": "https://api.grayswan.ai",
          "policyId": "pol_example",
          "violationThreshold": 0.5,
          "timeoutMs": 30000,
          "failOpen": true,
          "guardrailPriority": 80,
          "stages": {
            "beforeRequest": { "enabled": true, "mode": "block" },
            "beforeToolCall": { "enabled": true, "mode": "block" },
            "afterToolCall": {
              "enabled": true,
              "mode": "block",
              "blockMode": "append",
              "blockOnMutation": true,
              "blockOnIpi": true
            },
            "afterResponse": { "enabled": true, "mode": "block" }
          }
        }
      }
    }
  }
}
```

Notes:

- `apiKey` can be omitted if you set the `GRAYSWAN_API_KEY` environment variable.
- Config supports `${VAR_NAME}` substitution for environment variables.
- `apiBase` defaults to `https://api.grayswan.ai` (or `GRAYSWAN_API_BASE` if set).
- `policyId` maps to `policy_id` in `/cygnal/monitor` requests.
- `categories` and `reasoningMode` are forwarded as `categories` and `reasoning_mode`.

### GPT-OSS-Safeguard

GPT-OSS-Safeguard guardrails use local inference via Ollama or any OpenAI-compatible endpoint (e.g., OpenRouter) to run GPT-OSS-Safeguard models.

Configuration example:

```json
{
  "plugins": {
    "entries": {
      "gpt-oss-safeguard": {
        "enabled": true,
        "config": {
          "provider": "openrouter",
          "model": "openai/gpt-oss-safeguard-120b",
          "policy": "Your custom safety policy here...",
          "reasoningEffort": "medium",
          "outputFormat": "json",
          "timeoutMs": 30000,
          "failOpen": true,
          "guardrailPriority": 60,
          "stages": {
            "beforeRequest": { "enabled": true, "mode": "block" },
            "afterResponse": { "enabled": true, "mode": "monitor" }
          }
        }
      }
    }
  }
}
```

Notes:

- Uses the built-in model provider system (supports any provider configured in `auth.profiles`)
- `policy`: Custom safety policy text (400-600 tokens recommended). If omitted, uses a default policy focused on prompt injection, secret exfiltration, tool misuse, and basic safety/PII checks.
- `systemPromptMode`: `append` (default) adds the policy as extra system prompt context; `inline` embeds policy + content into a single user prompt (not recommended — likely to fail with GPT-OSS-Safeguard).
- `reasoningEffort`: Controls model reasoning depth (`low`, `medium`, `high`). Default: `medium`
- `outputFormat`: Response format from the model:
  - `binary`: Returns `0` (safe) or `1` (violation)
  - `json`: Returns `{"violation": 0|1, "policy_category": "..."}`
  - `rich`: Returns JSON with additional `confidence` and `rationale` fields
- `maxTokens`: Default `500` (higher than most guardrails to accommodate reasoning output)

## Per-stage options

Each stage can be configured with:

- `enabled`: default `true` when the stage entry exists
- `mode`: `block` or `monitor`
- `blockMode`: `replace` or `append` (defaults to `append` for `afterToolCall`, `replace` for others)
- `includeHistory`: default `true`

**Gray Swan** additionally supports:

- `violationThreshold`: override the default threshold (0.0 to 1.0)
- `blockOnMutation`: default `true` only for `afterToolCall`
- `blockOnIpi`: default `true` only for `afterToolCall`

**GPT-OSS-Safeguard** options:

- `provider`: Model provider (e.g., `ollama`, `openrouter`)
- `model`: Model identifier
- `authProfileId`: Optional auth profile for the model provider
- `timeoutMs`: Request timeout in milliseconds (default: 30000)
- `failOpen`: Allow requests on model errors (default: true)
- `maxTokens`: Maximum tokens for model response

## Block behavior

When a guardrail flags a violation and `mode: "block"`:

- `before_request` blocks the model call and returns a guardrail response.
- `before_tool_call` blocks the tool call and returns a synthetic tool result with a guardrail warning.
- `after_tool_call` mutates the tool result before the model sees it:
  - `blockMode: "append"` adds a warning to the tool result content
  - `blockMode: "replace"` replaces the tool result with a guardrail warning
- `after_response` replaces the assistant response (or appends a warning if `blockMode: "append"`).

If `mode: "monitor"`, OpenClaw only logs the evaluation and leaves the payload unchanged.

## Troubleshooting

- Use `openclaw gateway run --verbose` and `openclaw logs --follow` to see guardrail events.
- Guardrail errors follow `failOpen`: when `true`, errors are logged but do not block.
- If you see unexpected blocking, confirm the effective threshold and stage config.
- Guardrail plugin config changes require a gateway restart. Hot reload (`gateway.reload.mode=hot`) will ignore `plugins.*` changes.
- To apply config changes automatically, set `gateway.reload.mode=hybrid` or `gateway.reload.mode=restart`, or restart manually with `openclaw gateway restart`.
