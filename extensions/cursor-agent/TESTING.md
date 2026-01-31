# Testing Guide for Cursor Agent Extension

This guide covers the different levels of testing for the Cursor Agent extension.

## Test Layers

```
┌────────────────────────────────────────────┐
│           End-to-End (E2E) Tests           │  Real Cursor API + Real OpenClaw
├────────────────────────────────────────────┤
│           Integration Tests                │  Mock API Server + Real Extension
├────────────────────────────────────────────┤
│              Unit Tests                    │  Isolated function tests
└────────────────────────────────────────────┘
```

## 1. Unit Tests

Run unit tests with Vitest:

```bash
# From the extension directory
cd extensions/cursor-agent

# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# With coverage
pnpm test:coverage
```

### Test Files

| File                     | Coverage                                       |
| ------------------------ | ---------------------------------------------- |
| `src/api.test.ts`        | Webhook signature verification, header parsing |
| `src/config.test.ts`     | Configuration loading, account resolution      |
| `src/outbound.test.ts`   | Message parsing (repo/branch extraction)       |
| `src/task-store.test.ts` | Task storage and correlation                   |
| `src/monitor.test.ts`    | Webhook processing, payload validation         |
| `src/plugin.test.ts`     | Plugin structure, config adapter               |

### Running from Root

```bash
# From openclaw root
pnpm test -- extensions/cursor-agent
```

## 2. Integration Tests with Mock Server

The mock server simulates the Cursor API for testing without a real API key.

### Start Mock Server

```bash
# Terminal 1: Start mock server
cd extensions/cursor-agent
pnpm mock-server

# Output:
# 🤖 Mock Cursor API Server running on http://localhost:3456
```

### Test Against Mock

```bash
# Terminal 2: Run tests
export CURSOR_API_KEY="mock-key"
export CURSOR_API_BASE_URL="http://localhost:3456"

# Test listing agents
pnpm test:api list

# Test launching an agent
pnpm test:api launch "Add a README file" https://github.com/test/repo main
```

### Mock Server Features

- **Simulated Execution**: Agents transition from PENDING → RUNNING → FINISHED/ERROR
- **Webhook Callbacks**: Sends webhooks to configured URLs
- **90% Success Rate**: Simulates occasional failures
- **In-Memory Storage**: No persistence, resets on restart

## 3. End-to-End Tests with Real API

Test with a real Cursor API key for production validation.

### Prerequisites

1. Get API key from [Cursor Dashboard](https://cursor.com/dashboard?tab=background-agents)
2. Have a GitHub repository connected to Cursor

### Run E2E Tests

```bash
# Set your real API key
export CURSOR_API_KEY="your-real-api-key"

# List existing agents
pnpm test:api list

# Launch a real agent (creates a branch/PR!)
pnpm test:api launch "Add a simple README.md" https://github.com/your-org/your-repo main

# Check agent status
pnpm test:api details bc_xxxxx
```

### Webhook Testing

1. **Expose a webhook endpoint** (e.g., with ngrok):

   ```bash
   ngrok http 18789
   ```

2. **Configure webhook** in your test config:

   ```json
   {
     "webhookUrl": "https://abc123.ngrok.io/cursor-agent/default/webhook",
     "webhookSecret": "your-secret"
   }
   ```

3. **Monitor incoming webhooks** in Gateway logs

## 4. Manual Testing via OpenClaw

Test the full integration through OpenClaw channels.

### Setup

1. Add configuration to `~/.openclaw/openclaw.json`:

   ```json
   {
     "channels": {
       "cursorAgent": {
         "accounts": {
           "default": {
             "enabled": true,
             "apiKey": "your-api-key",
             "repository": "https://github.com/your-org/your-repo"
           }
         }
       }
     }
   }
   ```

2. Start the Gateway:

   ```bash
   pnpm gateway:watch
   ```

3. Send a test message via CLI:
   ```bash
   openclaw agent --message "Add a LICENSE file" --channel cursor-agent
   ```

### Test via WhatsApp/Telegram

Once connected to a messaging channel, send:

```
@repo:https://github.com/your-org/repo Add unit tests for utils.ts
```

## Test Scenarios

### Happy Path

1. ✅ Launch agent with valid config
2. ✅ Receive RUNNING webhook
3. ✅ Receive FINISHED webhook with PR URL
4. ✅ Result routed back to original session

### Error Handling

1. ⚠️ Invalid API key → Clear error message
2. ⚠️ Missing repository → Prompt for repo
3. ⚠️ Agent fails → Error webhook processed
4. ⚠️ Webhook signature mismatch → Request rejected

### Edge Cases

1. 🔄 Multiple concurrent agents
2. 🔄 Session timeout before webhook
3. 🔄 Large instructions (test limits)
4. 🔄 Special characters in repo URL

## Debugging

### Enable Verbose Logging

```bash
# Gateway with verbose logging
pnpm gateway:watch -- --verbose

# Or set environment variable
DEBUG=cursor-agent:* pnpm gateway:watch
```

### Check Task Store

```typescript
// In a test or debug script
import { getTaskStore, getPendingTasks } from "./src/task-store.js";

// View all tasks
console.log([...getTaskStore().entries()]);

// View pending tasks
console.log(getPendingTasks());
```

### Webhook Inspection

Use a tool like [webhook.site](https://webhook.site) to inspect webhook payloads:

```json
{
  "webhookUrl": "https://webhook.site/your-unique-id"
}
```

## CI Integration

### GitHub Actions Example

```yaml
name: Test Cursor Agent Extension

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install
      - run: pnpm test -- extensions/cursor-agent
```

### With Real API (Secrets)

```yaml
e2e:
  runs-on: ubuntu-latest
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  steps:
    # ... setup steps ...
    - run: pnpm test:api list
      env:
        CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
```

## Coverage Goals

| Area       | Target | Notes              |
| ---------- | ------ | ------------------ |
| API Client | 90%    | Core functionality |
| Config     | 95%    | Simple parsing     |
| Task Store | 95%    | Simple CRUD        |
| Webhook    | 80%    | Network-dependent  |
| Plugin     | 70%    | Integration-heavy  |

## Next Steps

- [ ] Add more edge case tests
- [ ] Create performance benchmarks
- [ ] Add stress tests for high volume
- [ ] Create Playwright tests for UI integration
