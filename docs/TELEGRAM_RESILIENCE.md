# Telegram Resilience Utilities

Resilience utilities for handling Telegram API failures and recovery processes.

## Components

**BotHealthCheck**: Periodically checks the health of the Bot API connection. Runs fail/recover callbacks based on a configurable failure threshold.

**Circuit**: Implements the circuit breaker pattern to prevent cascading failures. Manages Closed → Open → Half-Open state transitions.

**retryWithBackoff**: Provides automatic retry logic with exponential backoff and jitter.

## Usage

```typescript
import { BotHealthCheck } from "./health.js";
import { Circuit } from "./circuit.js";
import { retryWithBackoff } from "./retry.js";

// Health monitoring
const health = new BotHealthCheck(bot, logger, {
  interval: 30000,
  timeoutMs: 5000,
  failureThreshold: 3,
  onFail: () => console.log("bot offline"),
  onRecover: () => console.log("bot back online"),
});

health.start();
const isHealthy = health.isHealthy();
health.stop();

// Circuit breaker
const circuit = new Circuit(logger, { failures: 5, timeout: 30000 });

try {
  const result = await circuit.exec(() => bot.api.getMe());
} catch (error) {
  if (error.message === "circuit open") {
    console.log("circuit is open, request rejected");
  }
}

// Retry logic
const result = await retryWithBackoff(
  () => bot.api.sendMessage(chatId, text),
  { attempts: 3, minDelayMs: 1000, maxDelayMs: 10000 }
);
```

## Integration Points

- **Poll Loop Recovery**: Automatic backoff + reconnect during transient getUpdates timeouts
- **Outbound API Calls**: Circuit breaker for operations like sendMessage, answerCallback, etc.
- **Rate Limit Handling**: Handle 429 responses with backoff (without tripping the circuit breaker)

## Testing

Unit tests: `src/telegram/resilience.test.ts`

Covers state transitions, failure tracking, and timeout behavior.
