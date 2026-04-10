# Rate Limit Circuit Breaker

Prevents death loops in multi-agent group chats (Matrix, Discord, etc.) when LLM API rate limits are hit.

## Problem

When multiple agents share a group chat with `requireMention: false`, a single rate-limit error can cascade into an infinite loop:

1. Agent A receives a message → calls LLM API → gets rate-limited (429)
2. Gateway surfaces the error as a chat message: "API rate limit reached"
3. Agent B sees this message → tries to respond → also gets rate-limited
4. Repeat indefinitely

This loop is self-sustaining because the error messages themselves trigger more API calls.

## Solution

This plugin hooks into `message_sending` to detect and suppress repeated rate-limit error messages using a circuit breaker pattern:

- **CLOSED**: Normal operation. Counts consecutive rate-limit errors per room.
- **OPEN**: After N consecutive errors (default: 3), suppresses further error messages for a cooldown period. Normal messages still flow through.
- **HALF_OPEN**: After cooldown expires, allows one error message through as a retry probe. If the next message is normal (non-error), the circuit fully resets. If another error occurs, the circuit re-opens with doubled cooldown.

Exponential backoff ensures the cooldown grows (60s → 120s → 240s → ... up to 10 minutes) if the rate limit persists.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "rate-limit-circuit-breaker": {
        "enabled": true,
        "config": {
          "maxConsecutiveErrors": 3,
          "baseCooldownMs": 60000,
          "maxCooldownMs": 600000
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxConsecutiveErrors` | 3 | Consecutive rate-limit errors before circuit opens |
| `baseCooldownMs` | 60000 | Base cooldown (60s), doubles each trip |
| `maxCooldownMs` | 600000 | Maximum cooldown cap (10 minutes) |

## Recommended companion config

For best results, also configure fallback models so rate limits trigger model failover before reaching `surface_error`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "provider/model-a",
        "fallbacks": ["provider/model-b", "provider/model-c"]
      }
    }
  }
}
```

With fallback models, rate limits are handled by model switching (first line of defense). The circuit breaker acts as a second line of defense for when all models are exhausted.
