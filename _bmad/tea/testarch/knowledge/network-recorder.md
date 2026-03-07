# Network Recorder Utility

## Principle

Record network traffic to HAR files during test execution, then play back from disk for offline testing. Enables frontend tests to run in complete isolation from backend services with intelligent stateful CRUD detection for realistic API behavior.

## Rationale

Traditional E2E tests require live backend services:

- Slow (real network latency)
- Flaky (backend instability affects tests)
- Expensive (full stack running for UI tests)
- Coupled (UI tests break when API changes)

HAR-based recording/playback provides:

- **True offline testing**: UI tests run without backend
- **Deterministic behavior**: Same responses every time
- **Fast execution**: No network latency
- **Stateful mocking**: CRUD operations work naturally (not just read-only)
- **Environment flexibility**: Map URLs for any environment

## Quick Start

### 1. Record Network Traffic

```typescript
// Set mode to 'record' to capture network traffic
process.env.PW_NET_MODE = "record";

test("should add, edit and delete a movie", async ({ page, context, networkRecorder }) => {
  // Setup network recorder - it will record all network traffic
  await networkRecorder.setup(context);

  // Your normal test code
  await page.goto("/");
  await page.fill("#movie-name", "Inception");
  await page.click("#add-movie");

  // Network traffic is automatically saved to HAR file
});
```

### 2. Playback Network Traffic

```typescript
// Set mode to 'playback' to use recorded traffic
process.env.PW_NET_MODE = "playback";

test("should add, edit and delete a movie", async ({ page, context, networkRecorder }) => {
  // Setup network recorder - it will replay from HAR file
  await networkRecorder.setup(context);

  // Same test code runs without hitting real backend!
  await page.goto("/");
  await page.fill("#movie-name", "Inception");
  await page.click("#add-movie");
});
```

That's it! Your tests now run completely offline using recorded network traffic.

## Pattern Examples

### Example 1: Basic Record and Playback

**Context**: The fundamental pattern - record traffic once, play back for all subsequent runs.

**Implementation**:

```typescript
import { test } from "@seontechnologies/playwright-utils/network-recorder/fixtures";

// Set mode in test file (recommended)
process.env.PW_NET_MODE = "playback"; // or 'record'

test("CRUD operations work offline", async ({ page, context, networkRecorder }) => {
  // Setup recorder (records or plays back based on PW_NET_MODE)
  await networkRecorder.setup(context);

  await page.goto("/");

  // First time (record mode): Records all network traffic to HAR
  // Subsequent runs (playback mode): Plays back from HAR (no backend!)
  await page.fill("#movie-name", "Inception");
  await page.click("#add-movie");

  // Intelligent CRUD detection makes this work offline!
  await expect(page.getByText("Inception")).toBeVisible();
});
```

**Key Points**:

- `PW_NET_MODE=record` captures traffic to HAR files
- `PW_NET_MODE=playback` replays from HAR files
- Set mode in test file or via environment variable
- HAR files auto-organized by test name
- Stateful mocking detects CRUD operations

### Example 2: Complete CRUD Flow with HAR

**Context**: Full create-read-update-delete flow that works completely offline.

**Implementation**:

```typescript
process.env.PW_NET_MODE = "playback";

test.describe("Movie CRUD - offline with network recorder", () => {
  test.beforeEach(async ({ page, networkRecorder, context }) => {
    await networkRecorder.setup(context);
    await page.goto("/");
  });

  test("should add, edit, delete movie browser-only", async ({ page, interceptNetworkCall }) => {
    // Create
    await page.fill("#movie-name", "Inception");
    await page.fill("#year", "2010");
    await page.click("#add-movie");

    // Verify create (reads from stateful HAR)
    await expect(page.getByText("Inception")).toBeVisible();

    // Update
    await page.getByText("Inception").click();
    await page.fill("#movie-name", "Inception Director's Cut");

    const updateCall = interceptNetworkCall({
      method: "PUT",
      url: "/movies/*",
    });

    await page.click("#save");
    await updateCall; // Wait for update

    // Verify update (HAR reflects state change!)
    await page.click("#back");
    await expect(page.getByText("Inception Director's Cut")).toBeVisible();

    // Delete
    await page.click(`[data-testid="delete-Inception Director's Cut"]`);

    // Verify delete (HAR reflects removal!)
    await expect(page.getByText("Inception Director's Cut")).not.toBeVisible();
  });
});
```

**Key Points**:

- Full CRUD operations work offline
- Stateful HAR mocking tracks creates/updates/deletes
- Combine with `interceptNetworkCall` for deterministic waits
- First run records, subsequent runs replay

### Example 3: Common Patterns

**Recording Only API Calls**:

```typescript
await networkRecorder.setup(context, {
  recording: {
    urlFilter: /\/api\//, // Only record API calls, ignore static assets
  },
});
```

**Playback with Fallback**:

```typescript
await networkRecorder.setup(context, {
  playback: {
    fallback: true, // Fall back to live requests if HAR entry missing
  },
});
```

**Custom HAR File Location**:

```typescript
await networkRecorder.setup(context, {
  harFile: {
    harDir: "recordings/api-calls",
    baseName: "user-journey",
    organizeByTestFile: false, // Optional: flatten directory structure
  },
});
```

**Directory Organization:**

- `organizeByTestFile: true` (default): `har-files/test-file-name/baseName-test-title.har`
- `organizeByTestFile: false`: `har-files/baseName-test-title.har`

### Example 4: Response Content Storage - Embed vs Attach

**Context**: Choose how response content is stored in HAR files.

**`embed` (Default - Recommended):**

```typescript
await networkRecorder.setup(context, {
  recording: {
    content: "embed", // Store content inline (default)
  },
});
```

**Pros:**

- Single self-contained file - Easy to share, version control
- Better for small-medium responses (API JSON, HTML pages)
- HAR specification compliant

**Cons:**

- Larger HAR files
- Not ideal for large binary content (images, videos)

**`attach` (Alternative):**

```typescript
await networkRecorder.setup(context, {
  recording: {
    content: "attach", // Store content separately
  },
});
```

**Pros:**

- Smaller HAR files
- Better for large responses (images, videos, documents)

**Cons:**

- Multiple files to manage
- Harder to share

**When to Use Each:**

| Use `embed` (default) when          | Use `attach` when               |
| ----------------------------------- | ------------------------------- |
| Recording API responses (JSON, XML) | Recording large images, videos  |
| Small to medium HTML pages          | HAR file size >50MB             |
| You want a single, portable file    | Maximum disk efficiency needed  |
| Sharing HAR files with team         | Working with ZIP archive output |

### Example 5: Cross-Environment Compatibility (URL Mapping)

**Context**: Record in dev environment, play back in CI with different base URLs.

**The Problem**: HAR files contain URLs for the recording environment (e.g., `dev.example.com`). Playing back on a different environment fails.

**Simple Hostname Mapping:**

```typescript
await networkRecorder.setup(context, {
  playback: {
    urlMapping: {
      hostMapping: {
        "preview.example.com": "dev.example.com",
        "staging.example.com": "dev.example.com",
        "localhost:3000": "dev.example.com",
      },
    },
  },
});
```

**Pattern-Based Mapping (Recommended):**

```typescript
await networkRecorder.setup(context, {
  playback: {
    urlMapping: {
      patterns: [
        // Map any preview-XXXX subdomain to dev
        { match: /preview-\d+\.example\.com/, replace: "dev.example.com" },
      ],
    },
  },
});
```

**Custom Function:**

```typescript
await networkRecorder.setup(context, {
  playback: {
    urlMapping: {
      mapUrl: (url) => url.replace("staging.example.com", "dev.example.com"),
    },
  },
});
```

**Complex Multi-Environment Example:**

```typescript
await networkRecorder.setup(context, {
  playback: {
    urlMapping: {
      hostMapping: {
        "localhost:3000": "admin.seondev.space",
        "admin-staging.seon.io": "admin.seondev.space",
        "admin.seon.io": "admin.seondev.space",
      },
      patterns: [
        { match: /admin-\d+\.seondev\.space/, replace: "admin.seondev.space" },
        { match: /admin-staging-pr-\w+-\d\.seon\.io/, replace: "admin.seondev.space" },
      ],
    },
  },
});
```

**Benefits:**

- Record once on dev, all environments map back to recordings
- CORS headers automatically updated based on request origin
- Debug with: `LOG_LEVEL=debug npm run test`

## Why Use This Instead of Native Playwright?

| Native Playwright (`routeFromHAR`) | network-recorder Utility       |
| ---------------------------------- | ------------------------------ |
| ~80 lines setup boilerplate        | ~5 lines total                 |
| Manual HAR file management         | Automatic file organization    |
| Complex setup/teardown             | Automatic cleanup via fixtures |
| **Read-only tests only**           | **Full CRUD support**          |
| **Stateless**                      | **Stateful mocking**           |
| Manual URL mapping                 | Automatic environment mapping  |

**The game-changer: Stateful CRUD detection**

Native Playwright HAR playback is stateless - a POST create followed by GET list won't show the created item. This utility intelligently tracks CRUD operations in memory to reflect state changes, making offline tests behave like real APIs.

## How Stateful CRUD Detection Works

When in playback mode, the Network Recorder automatically analyzes your HAR file to detect CRUD patterns. If it finds:

- Multiple GET requests to the same resource endpoint (e.g., `/movies`)
- Mutation operations (POST, PUT, DELETE) to those resources
- Evidence of state changes between identical requests

It automatically switches from static HAR playback to an intelligent stateful mock that:

- Maintains state across requests
- Auto-generates IDs for new resources
- Returns proper 404s for deleted resources
- Supports polling scenarios where state changes over time

**This happens automatically - no configuration needed!**

## API Reference

### NetworkRecorder Methods

| Method               | Return Type              | Description                                   |
| -------------------- | ------------------------ | --------------------------------------------- |
| `setup(context)`     | `Promise<void>`          | Sets up recording/playback on browser context |
| `cleanup()`          | `Promise<void>`          | Flushes data to disk and cleans up memory     |
| `getContext()`       | `NetworkRecorderContext` | Gets current recorder context information     |
| `getStatusMessage()` | `string`                 | Gets human-readable status message            |
| `getHarStats()`      | `Promise<HarFileStats>`  | Gets HAR file statistics and metadata         |

### Understanding `cleanup()`

The `cleanup()` method performs memory and resource cleanup - **it does NOT delete HAR files**:

**What it does:**

- Flushes recorded data to disk (writes HAR file in recording mode)
- Releases file locks
- Clears in-memory data
- Resets internal state

**What it does NOT do:**

- Delete HAR files from disk
- Remove recorded network traffic
- Clear browser context or cookies

### Configuration Options

```typescript
type NetworkRecorderConfig = {
  harFile?: {
    harDir?: string; // Directory for HAR files (default: 'har-files')
    baseName?: string; // Base name for HAR files (default: 'network-traffic')
    organizeByTestFile?: boolean; // Organize by test file (default: true)
  };

  recording?: {
    content?: "embed" | "attach"; // Response content handling (default: 'embed')
    urlFilter?: string | RegExp; // URL filter for recording
    update?: boolean; // Update existing HAR files (default: false)
  };

  playback?: {
    fallback?: boolean; // Fall back to live requests (default: false)
    urlFilter?: string | RegExp; // URL filter for playback
    updateMode?: boolean; // Update mode during playback (default: false)
  };

  forceMode?: "record" | "playback" | "disabled";
};
```

## Environment Configuration

Control the recording mode using the `PW_NET_MODE` environment variable:

```bash
# Record mode - captures network traffic to HAR files
PW_NET_MODE=record npm run test:pw

# Playback mode - replays network traffic from HAR files
PW_NET_MODE=playback npm run test:pw

# Disabled mode - no network recording/playback
PW_NET_MODE=disabled npm run test:pw

# Default behavior (when PW_NET_MODE is empty/unset) - same as disabled
npm run test:pw
```

**Tip**: We recommend setting `process.env.PW_NET_MODE` directly in your test file for better control.

## Troubleshooting

### HAR File Not Found

If you see "HAR file not found" errors during playback:

1. Ensure you've recorded the test first with `PW_NET_MODE=record`
2. Check the HAR file exists in the expected location (usually `har-files/`)
3. Enable fallback mode: `playback: { fallback: true }`

### Authentication and Network Recording

The network recorder works seamlessly with authentication:

```typescript
test("Authenticated recording", async ({ page, context, authSession, networkRecorder }) => {
  // First authenticate
  await authSession.login("testuser", "password");

  // Then setup network recording with authenticated context
  await networkRecorder.setup(context);

  // Test authenticated flows
  await page.goto("/dashboard");
});
```

### Concurrent Test Issues

The recorder includes built-in file locking for safe parallel execution. Each test gets its own HAR file based on the test name.

## Integration with Other Utilities

**With interceptNetworkCall (deterministic waits):**

```typescript
test("use both utilities", async ({ page, context, networkRecorder, interceptNetworkCall }) => {
  await networkRecorder.setup(context);

  const createCall = interceptNetworkCall({
    method: "POST",
    url: "/api/movies",
  });

  await page.click("#add-movie");
  await createCall; // Wait for create (works with HAR!)

  // Network recorder provides playback, intercept provides determinism
});
```

## Related Fragments

- `overview.md` - Installation and fixture patterns
- `intercept-network-call.md` - Combine for deterministic offline tests
- `auth-session.md` - Record authenticated traffic
- `network-first.md` - Core pattern for intercept-before-navigate

## Anti-Patterns

**DON'T mix record and playback in same test:**

```typescript
process.env.PW_NET_MODE = "record";
// ... some test code ...
process.env.PW_NET_MODE = "playback"; // Don't switch mid-test
```

**DO use one mode per test:**

```typescript
process.env.PW_NET_MODE = "playback"; // Set once at top

test("my test", async ({ page, context, networkRecorder }) => {
  await networkRecorder.setup(context);
  // Entire test uses playback mode
});
```

**DON'T forget to call setup:**

```typescript
test("broken", async ({ page, networkRecorder }) => {
  await page.goto("/"); // HAR not active!
});
```

**DO always call setup before navigation:**

```typescript
test("correct", async ({ page, context, networkRecorder }) => {
  await networkRecorder.setup(context); // Must setup first
  await page.goto("/"); // Now HAR is active
});
```
