# @openclaw/retry-backoff

Exponential retry backoff extension for openclaw — automatic retry with
back-off on retryable model failures.

## Enabling the Plugin

This plugin is **not loaded by default**. Add it to the `plugins.entries` section of your openclaw config with `enabled: true`:

```jsonc
{
  "plugins": {
    "entries": {
      "retry-backoff": {
        "enabled": true,
        "config": {
          "retryMaxRounds": 3
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
| **429 handling** | Classifies HTTP 429 errors, extracts `Retry-After` headers, and uses the larger of server-requested delay and computed backoff. |
| **Error classification** | Classifies unknown errors into retryable categories based on HTTP status codes and error messages. |

## Configuration

```jsonc
{
  "retryMaxRounds": 2,         // Max retry attempts (default: 2)
  "retryBaseDelayMs": 15000,   // Initial retry delay in ms (default: 15000)
  "retryMaxDelayMs": 60000     // Maximum retry delay cap in ms (default: 60000)
}
```

## Exported API

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

## Development

```bash
cd extensions/retry-backoff
npm test
```
