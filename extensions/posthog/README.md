# @openclaw/posthog

PostHog LLM Analytics plugin for OpenClaw. Captures LLM generations, tool executions, and conversation traces, sending them to PostHog as structured `$ai_*` events for the LLM Analytics dashboard.

## Install

```bash
# In your OpenClaw extensions directory
cd ~/.openclaw/extensions && npm install @openclaw/posthog posthog-node
```

## Configuration

Add to your `openclaw.json` (or `openclaw.yaml`):

```jsonc
{
  "plugins": {
    "entries": {
      "posthog": {
        "enabled": true,
        "config": {
          "apiKey": "phc_your_project_key",
          "host": "https://us.i.posthog.com",
          "privacyMode": true,
          "traceGrouping": "message",
          "sessionWindowMinutes": 60,
        },
      },
    },
  },
  "diagnostics": {
    "enabled": true,
  },
}
```

### Options

| Option                 | Type                       | Default                    | Description                                                                                                           |
| ---------------------- | -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apiKey`               | `string`                   | _(required)_               | Your PostHog project API key                                                                                          |
| `host`                 | `string`                   | `https://us.i.posthog.com` | PostHog instance URL                                                                                                  |
| `privacyMode`          | `boolean`                  | `true`                     | When enabled, LLM input/output content is not sent to PostHog                                                         |
| `traceGrouping`        | `"message"` \| `"session"` | `"message"`                | Trace grouping mode. `"message"`: one trace per runId. `"session"`: group all generations in a session into one trace |
| `sessionWindowMinutes` | `number`                   | `60`                       | Minutes of inactivity before starting a new session window. Applies to both trace grouping modes                      |
| `enabled`              | `boolean`                  | `true`                     | Enable or disable the plugin                                                                                          |

> **Note:** `diagnostics.enabled` must be `true` in your OpenClaw config for trace-level events (`$ai_trace`) to be captured.

## What gets captured

### `$ai_generation`

Captured on every LLM call (correlated `llm_input` + `llm_output` hooks).

| Property                      | Description                                                      |
| ----------------------------- | ---------------------------------------------------------------- |
| `$ai_model`                   | Model name (e.g. `gpt-4o`, `claude-3`)                           |
| `$ai_provider`                | Provider name (e.g. `openai`, `anthropic`)                       |
| `$ai_latency`                 | Request duration in seconds                                      |
| `$ai_input_tokens`            | Input token count                                                |
| `$ai_output_tokens`           | Output token count                                               |
| `$ai_total_cost_usd`          | Total cost in USD                                                |
| `$ai_input_cost_usd`          | Input cost in USD                                                |
| `$ai_output_cost_usd`         | Output cost in USD                                               |
| `$ai_stop_reason`             | Why generation stopped (`stop`, `length`, `tool_calls`, `error`) |
| `$ai_is_error`                | Whether the generation errored                                   |
| `$ai_error`                   | Error message (if any)                                           |
| `$ai_input`                   | Input messages in OpenAI format (redacted in privacy mode)       |
| `$ai_output_choices`          | Output choices (redacted in privacy mode)                        |
| `$ai_trace_id`                | Trace ID for hierarchical grouping                               |
| `$ai_span_id`                 | Span ID for this generation                                      |
| `$ai_session_id`              | Session identifier                                               |
| `$ai_channel`                 | Message channel (e.g. `telegram`, `slack`)                       |
| `$ai_agent_id`                | Agent identifier                                                 |
| `cache_read_input_tokens`     | Cache read token count                                           |
| `cache_creation_input_tokens` | Cache creation token count                                       |

### `$ai_span`

Captured for each tool call (`after_tool_call` hook).

| Property           | Description                                      |
| ------------------ | ------------------------------------------------ |
| `$ai_span_name`    | Tool name                                        |
| `$ai_latency`      | Tool execution duration in seconds               |
| `$ai_is_error`     | Whether the tool call errored                    |
| `$ai_error`        | Error message (if any)                           |
| `$ai_input_state`  | Tool input parameters (redacted in privacy mode) |
| `$ai_output_state` | Tool output result (redacted in privacy mode)    |
| `$ai_trace_id`     | Trace ID                                         |
| `$ai_span_id`      | Span ID for this tool call                       |
| `$ai_parent_id`    | Parent generation span ID                        |

### `$ai_trace`

Captured when a message cycle completes (`message.processed` diagnostic event).

| Property                  | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `$ai_trace_id`            | Trace ID                                                      |
| `$ai_session_id`          | Session identifier                                            |
| `$ai_latency`             | Total message cycle duration in seconds                       |
| `$ai_total_input_tokens`  | Accumulated input tokens across all generations in the trace  |
| `$ai_total_output_tokens` | Accumulated output tokens across all generations in the trace |
| `$ai_is_error`            | Whether the message cycle errored                             |
| `$ai_error`               | Error message (if any)                                        |
| `$ai_channel`             | Message channel                                               |

## Privacy

With `privacyMode: true` (the default), no message content, prompts, or tool parameters are sent to PostHog. Token counts, latency, model info, and error status are always captured.
