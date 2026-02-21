# @openclaw/agent-resilience

Agent stability extension for openclaw – timeout retry with exponential back-off
and automatic image block stripping.

## Enabling the Plugin

This plugin is **not loaded by default**. Add it to the `plugins.entries` section of your openclaw config with `enabled: true`:

```jsonc
{
  "plugins": {
    "entries": {
      "agent-resilience": {
        "enabled": true,
        "config": {
          "retryMaxRounds": 3,
          "imageStripEnabled": true
        }
      }
    }
  }
}
```

## Features

| Feature | Description |
|---------|-------------|
| **Retry back-off** | Exponential delay on retryable failures (`rate_limit`, `timeout`, `unknown`). Configurable base/max delay and max rounds. |
| **Image strip** | Replaces image content blocks with `[image omitted]` placeholder when the model returns an empty response, both in-memory and on disk. |

## Configuration

```jsonc
{
  "retryMaxRounds": 5,         // Max retry attempts
  "retryBaseDelayMs": 5000,    // Initial retry delay (ms)
  "retryMaxDelayMs": 120000,   // Maximum retry delay cap (ms)
  "imageStripEnabled": true,   // Enable auto image stripping
  "imageStripPersist": true    // Also strip images from session files on disk
}
```

## Exported API

### retry-backoff

| Export | Description |
|--------|-------------|
| `RETRYABLE_REASONS` | `Set<string>` of reasons considered retryable (`rate_limit`, `timeout`, `unknown`) |
| `RetryConfig` | Type: `{ baseDelayMs, maxDelayMs, maxRounds }` |
| `DEFAULT_RETRY_CONFIG` | Sensible defaults (2 rounds, 15s base, 60s max) |
| `computeRetryDelay(round, config)` | Returns delay in ms (exponential, capped) |
| `isRetryableRound(reason, round, config)` | Whether to retry for the given reason/round (accepts string or attempts array) |
| `classifyError(err)` | Classify an unknown error into a retryable reason (`rate_limit` for 429, `timeout` for 408/502/503/504/ECONNRESET, etc.) |
| `extractRetryAfterMs(err)` | Extract `Retry-After` header value in ms from error/response objects |
| `retryWithBackoff(fn, opts)` | Execute `fn` with automatic retry on retryable errors — supports 429 Retry-After, exponential back-off, AbortSignal, and onRetry callback |
| `sleep(ms)` | Promise-based delay helper |
| `ClassifiedError` | Error type with `status`, `retryAfterMs`, and `reason` fields |
| `RetryWithBackoffOptions` | Options for `retryWithBackoff`: `config`, `signal`, `onRetry` |

### image-strip

| Export | Description |
|--------|-------------|
| `ImageStripResult` | Type: `{ messages, hadImages }` |
| `stripImageBlocksFromMessages(msgs)` | In-memory image block replacement |
| `stripImageBlocksFromSessionFile(path)` | On-disk JSONL session file image stripping |
| `isEmptyAssistantContent(msg)` | Check whether an assistant message has no meaningful content |

## Development

```bash
cd extensions/agent-resilience
npm install
npm test
```
