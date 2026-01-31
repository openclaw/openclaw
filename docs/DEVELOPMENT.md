# Development Guide

## Prerequisites

- **Node.js**: v22 or later
- **npm/pnpm**: Package manager
- **Git**: Version control

Optional:

- **Cursor API Key**: For real API testing
- **ngrok/Tailscale**: For webhook testing

## Getting Started

### 1. Clone and Install

```bash
git clone https://github.com/openclaw/openclaw.git cursor-agent-openclaw
cd cursor-agent-openclaw
npm install
```

### 2. Setup Dev Environment

```bash
./dev/setup.sh
```

This creates an isolated environment:

- `dev/config/` - Configuration files
- `dev/data/` - Data storage
- `dev/.env` - Environment variables

### 3. Start Development

**Option A: With Mock API (no API key needed)**

```bash
# Terminal 1: Mock Cursor API
./dev/mock-cursor.sh

# Terminal 2: Gateway
CURSOR_API_BASE_URL=http://localhost:3456 ./dev/start.sh
```

**Option B: With Real API**

1. Get API key from https://cursor.com/dashboard?tab=background-agents
2. Edit `dev/config/openclaw.json`:
   ```json
   "apiKey": "your-real-api-key"
   ```
3. Start gateway:
   ```bash
   ./dev/start.sh
   ```

## Project Structure

```
extensions/cursor-agent/
├── index.ts                 # Plugin entry point
├── package.json            # Dependencies
├── README.md               # Extension docs
├── TESTING.md              # Test guide
├── scripts/
│   ├── test-api.ts         # CLI test tool
│   └── mock-cursor-api.ts  # Mock server
└── src/
    ├── api.ts              # Cursor API client
    ├── api.test.ts         # API tests
    ├── config.ts           # Config loading
    ├── config.test.ts      # Config tests
    ├── config-schema.ts    # Zod schema
    ├── monitor.ts          # Webhook handler
    ├── monitor.test.ts     # Monitor tests
    ├── onboarding.ts       # Setup wizard
    ├── outbound.ts         # Send messages
    ├── outbound.test.ts    # Outbound tests
    ├── plugin.ts           # Main plugin
    ├── plugin.test.ts      # Plugin tests
    ├── runtime.ts          # Runtime context
    ├── task-store.ts       # Task tracking
    ├── task-store.test.ts  # Store tests
    └── types.ts            # Type definitions
```

## Making Changes

### Adding a New Feature

1. **Update types** (`src/types.ts`):

   ```typescript
   export interface NewFeature {
     // ...
   }
   ```

2. **Implement logic** (relevant file):

   ```typescript
   export function newFeature() {
     // ...
   }
   ```

3. **Add tests** (`src/*.test.ts`):

   ```typescript
   describe("newFeature", () => {
     it("should do something", () => {
       // ...
     });
   });
   ```

4. **Run tests**:
   ```bash
   npx vitest run extensions/cursor-agent
   ```

### Modifying the API Client

The API client (`src/api.ts`) handles all Cursor API communication:

```typescript
// Add a new endpoint
export async function newEndpoint(
  account: CursorAgentAccountConfig,
  params: NewParams,
): Promise<NewResponse> {
  const response = await fetch(`${CURSOR_API_BASE_URL}/v0/new-endpoint`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(`API error: ${await response.text()}`);
  }

  return response.json();
}
```

### Adding Configuration Options

1. **Update schema** (`src/config-schema.ts`):

   ```typescript
   export const CursorAgentAccountSchema = z.object({
     // existing fields...
     newOption: z.string().optional(),
   });
   ```

2. **Update types** (`src/types.ts`):

   ```typescript
   export interface CursorAgentAccountConfig {
     // existing fields...
     newOption?: string;
   }
   ```

3. **Use in code**:
   ```typescript
   if (account.newOption) {
     // use it
   }
   ```

## Testing

### Unit Tests

```bash
# Run all extension tests
npx vitest run extensions/cursor-agent

# Watch mode
npx vitest extensions/cursor-agent

# With coverage
npx vitest run extensions/cursor-agent --coverage
```

### Integration Tests

```bash
# Start mock server
./dev/mock-cursor.sh

# In another terminal
./dev/test-cursor.sh list
./dev/test-cursor.sh launch "Test task" https://github.com/test/repo
```

### Manual Testing

1. Start the gateway:

   ```bash
   ./dev/start.sh
   ```

2. Open WebChat:
   http://localhost:18790

3. Send a message:
   ```
   Add a README.md @repo:https://github.com/test/repo
   ```

## Debugging

### Enable Debug Logging

```bash
DEBUG=cursor-agent:* ./dev/start.sh
```

### Check Task Store

```typescript
// Add to your test
import { getTaskStore, getPendingTasks } from "./src/task-store.js";

console.log("All tasks:", [...getTaskStore().entries()]);
console.log("Pending:", getPendingTasks());
```

### Inspect Webhooks

Use webhook.site for debugging:

1. Go to https://webhook.site
2. Copy your unique URL
3. Set as `webhookUrl` in config
4. Watch incoming requests

### Common Issues

**"Cannot find module"**

```bash
npm install
```

**"Port already in use"**

```bash
lsof -i :18790
kill -9 <PID>
```

**"Invalid signature"**

- Check `webhookSecret` matches in config
- Ensure raw body is used for verification

## Code Style

- **TypeScript**: Strict mode enabled
- **Formatting**: Prettier (run `npm run format`)
- **Linting**: ESLint (run `npm run lint`)
- **Tests**: Vitest with descriptive names

### Example Test Style

```typescript
describe("featureName", () => {
  describe("scenario", () => {
    it("should do expected behavior", () => {
      // Arrange
      const input = createTestInput();

      // Act
      const result = featureName(input);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

## Submitting Changes

1. **Create a branch**:

   ```bash
   git checkout -b feature/your-feature
   ```

2. **Make changes** with tests

3. **Run tests**:

   ```bash
   npx vitest run extensions/cursor-agent
   ```

4. **Commit**:

   ```bash
   git add .
   git commit -m "feat(cursor-agent): add new feature"
   ```

5. **Push and create PR**

## Resources

- [OpenClaw Docs](https://docs.openclaw.ai)
- [Cursor API Docs](https://cursor.com/docs/background-agent/api/)
- [Plugin SDK](../../src/plugin-sdk/index.ts)
- [Twitch Extension](../twitch/) (reference implementation)
