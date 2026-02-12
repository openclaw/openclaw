# Telegram Resilience

Utilities for handling Telegram API failures, retries, and recovery.

## Overview

This module provides three core mechanisms for building resilient Telegram bot interactions:

- **BotHealthCheck**: Continuous monitoring of bot connectivity
- **Circuit Breaker**: Prevents cascading failures by stopping requests to failing services

## Usage

```typescript
import { BotHealthCheck } from "./health.js";
import { Circuit } from "./circuit.js";

const health = new BotHealthCheck(bot, logger, {
  interval: 30000,
  onFail: () => console.log("bot offline"),
  onRecover: () => console.log("bot back online"),
});
health.start();

const circuit = new Circuit(logger, { failures: 5 });
await circuit.exec(() => bot.api.sendMessage(chatId, text));
```

## Components

### BotHealthCheck

Monitors the connection health of your Telegram bot by sending periodic health checks.

**Options:**

- `interval`: Health check frequency in milliseconds (default: 30000)
- `onFail`: Callback triggered when bot goes offline
- `onRecover`: Callback triggered when bot reconnects
- `timeout`: Request timeout in milliseconds (default: 5000)

### Circuit Breaker

Implements the circuit breaker pattern to prevent cascading failures.

**Options:**

- `failures`: Number of consecutive failures before circuit opens (default: 5)
- `timeout`: Duration circuit remains open in milliseconds (default: 60000)

## Error Handling

```typescript
try {
  const result = await circuit.exec(() => bot.api.sendMessage(chatId, text));
} catch (error) {
  if (error.message.includes("circuit open")) {
    console.error("Service temporarily unavailable");
  }
}
```

## Best Practices

1. Initialize `BotHealthCheck` at application startup
2. Wrap critical API calls with circuit breaker protection
3. Set health check interval based on your bot's heartbeat requirements
4. Monitor circuit breaker state changes for graceful degradation
