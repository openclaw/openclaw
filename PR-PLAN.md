# PR Plan: Chrome Profile Targeting for existing-session

## Issue

GitHub Issue #49241: When using `driver: "existing-session"`, OpenClaw connects via Chrome MCP's `--autoConnect` flag which grabs the first Chrome instance it discovers. If a user has multiple Chrome profile windows open (personal + work), the agent attaches to whichever one MCP finds first — there's no way to specify which profile to target.

## Root Cause Analysis

### 1. `resolveProfile()` discards cdpPort for existing-session profiles

In `src/browser/config.ts`, line ~235:

```typescript
if (driver === "existing-session") {
  return {
    cdpPort: 0, // HARDCODED — ignores profile.cdpPort from config
    cdpUrl: "", // HARDCODED — ignores profile.cdpUrl from config
    cdpHost: "",
    cdpIsLoopback: true,
    userDataDir: resolveUserPath(profile.userDataDir?.trim() || "") || undefined,
    color: profile.color,
    driver,
    attachOnly: true,
  };
}
```

Even if the user sets `cdpPort: 9222` in their profile config, it gets thrown away.

### 2. Chrome MCP is always launched with `--autoConnect` (no port targeting)

In `src/browser/chrome-mcp.ts`:

```typescript
const DEFAULT_CHROME_MCP_ARGS = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--autoConnect",
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
];
```

And `buildChromeMcpArgs()` only optionally adds `--userDataDir`:

```typescript
export function buildChromeMcpArgs(userDataDir?: string): string[] {
  const normalizedUserDataDir = normalizeChromeMcpUserDataDir(userDataDir);
  return normalizedUserDataDir
    ? [...DEFAULT_CHROME_MCP_ARGS, "--userDataDir", normalizedUserDataDir]
    : [...DEFAULT_CHROME_MCP_ARGS];
}
```

No support for `--port` to target a specific Chrome debug port.

### 3. The data flow never passes cdpPort to MCP

The entire chain: `config → resolveProfile → server-context → chrome-mcp` never threads a CDP port for existing-session profiles because `resolveProfile()` zeros it out at step 1.

## Solution

### Approach: CDP Port-Based Targeting

The cleanest approach: let users launch each Chrome profile with a different `--remote-debugging-port` and configure OpenClaw to connect to the specific port.

**Why this approach:**

- `chrome-devtools-mcp` already supports `--port <number>` to target a specific CDP port instead of auto-discovering
- Doesn't require scraping Chrome internals or checking logged-in Google accounts
- Users already know how to launch Chrome with `--remote-debugging-port=XXXX`
- Each profile window gets a unique port = deterministic targeting
- Works on all platforms (macOS, Windows, Linux)

**User experience after fix:**

```json
{
  "browser": {
    "profiles": {
      "personal": {
        "driver": "existing-session",
        "cdpPort": 9222,
        "color": "#00AA00"
      },
      "work": {
        "driver": "existing-session",
        "cdpPort": 9223,
        "color": "#FF0000"
      }
    }
  }
}
```

User launches Chrome profiles:

```bash
# Personal profile
open -na "Google Chrome" --args --profile-directory="Profile 1" --remote-debugging-port=9222

# Work profile
open -na "Google Chrome" --args --profile-directory="Profile 3" --remote-debugging-port=9223
```

## Files to Modify

### 1. `src/browser/config.ts` — `resolveProfile()`

**What:** Stop discarding `cdpPort` for existing-session profiles. Pass it through to `ResolvedBrowserProfile`.
**How:** When `driver === "existing-session"` and `profile.cdpPort` is set, include it in the return value instead of hardcoding 0.

### 2. `src/browser/chrome-mcp.ts` — `buildChromeMcpArgs()` + `createRealSession()`

**What:** Thread `cdpPort` through to MCP args. When a port is specified, pass `--port <number>` to `chrome-devtools-mcp` so it connects to that specific debug port instead of auto-discovering.
**How:**

- Update `buildChromeMcpArgs()` signature to accept `cdpPort?: number`
- When `cdpPort` is provided and > 0, add `--port`, `<cdpPort>` to the args array
- Update `createRealSession()` to accept and forward `cdpPort`
- Update `getSession()` and `callTool()` to thread `cdpPort` through
- Update cache key to include cdpPort (so different ports get different sessions)

### 3. `src/browser/chrome-mcp.ts` — All exported functions

**What:** Add `cdpPort?: number` parameter to all exported functions that call `callTool()`.
**How:** Each function like `listChromeMcpPages`, `openChromeMcpTab`, `takeChromeMcpSnapshot`, etc. needs to accept and forward `cdpPort`.

### 4. Call sites that pass profile data to chrome-mcp functions

**What:** Thread `cdpPort` from `ResolvedBrowserProfile` to chrome-mcp function calls.
**How:** Search for all call sites of chrome-mcp functions and pass `profile.cdpPort` where available.

### 5. `src/config/types.browser.ts` — Documentation

**What:** Update JSDoc on `cdpPort` in `BrowserProfileConfig` to clarify it works with existing-session too.

### 6. Tests

- Update existing tests in `src/browser/config.test.ts` for the new resolveProfile behavior
- Update existing tests in `src/browser/server-context.existing-session.test.ts`
- Add a test in chrome-mcp tests for `buildChromeMcpArgs` with cdpPort

## What NOT to Change

- Don't change the default behavior (no cdpPort = autoConnect as before)
- Don't add new config fields — `cdpPort` already exists in BrowserProfileConfig
- Don't change how `userDataDir` works — it's orthogonal
- Don't change the extension or openclaw driver flows

## Testing Strategy

1. Unit tests for `resolveProfile()` with existing-session + cdpPort
2. Unit tests for `buildChromeMcpArgs()` with cdpPort parameter
3. Verify existing tests still pass (no regressions)
4. Manual test: launch 2 Chrome profiles with different ports, connect to each

## Backward Compatibility

- Fully backward compatible: existing configs without `cdpPort` on existing-session profiles work exactly as before (autoConnect)
- Only behavior change: when `cdpPort` IS specified, it's now respected instead of silently discarded
