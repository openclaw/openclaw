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

| Option        | Type      | Default                    | Description                                                   |
| ------------- | --------- | -------------------------- | ------------------------------------------------------------- |
| `apiKey`      | `string`  | _(required)_               | Your PostHog project API key                                  |
| `host`        | `string`  | `https://us.i.posthog.com` | PostHog instance URL                                          |
| `privacyMode` | `boolean` | `true`                     | When enabled, LLM input/output content is not sent to PostHog |
| `enabled`     | `boolean` | `true`                     | Enable or disable the plugin                                  |

> **Note:** `diagnostics.enabled` must be `true` in your OpenClaw config for trace-level events (`$ai_trace`) to be captured.

## What gets captured

### `$ai_generation`

Captured on every LLM call (correlated `llm_input` + `llm_output` hooks). Includes:

- Model, provider, latency, token counts (input/output/cache)
- Input messages and output choices (unless `privacyMode` is enabled)
- Trace and span IDs for hierarchical grouping

### `$ai_span`

Captured for each tool call (`after_tool_call` hook). Includes:

- Tool name, duration, error status
- Input parameters and output result (unless `privacyMode` is enabled)
- Parent span ID linking back to the generation that invoked the tool

### `$ai_trace`

Captured when a message cycle completes (`message.processed` diagnostic event). Includes:

- Total duration, outcome (completed/error), channel

## Privacy

With `privacyMode: true` (the default), no message content, prompts, or tool parameters are sent to PostHog. Token counts, latency, model info, and error status are always captured.
