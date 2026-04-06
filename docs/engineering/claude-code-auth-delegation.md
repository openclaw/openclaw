# Implementing Claude Code Auth Delegation in OpenClaw

Reference implementation: [T3 Code](https://github.com/t3dotgg/t3code) (`apps/server/src/provider/Layers/ClaudeAdapter.ts`, `ClaudeProvider.ts`)

## Background

T3 Code implements a **zero-credential delegation model** for Claude. Instead of storing API keys or OAuth tokens, it spawns the `claude` CLI binary via the `@anthropic-ai/claude-agent-sdk` and lets the binary handle all credential management internally. The app never sees, stores, or transmits secrets.

OpenClaw already has a rich auth system (API keys, OAuth profiles, setup tokens) for Anthropic. This guide describes how to **add a parallel SDK-delegation path** that piggybacks on the user's existing `claude` CLI login, similar to what T3 Code does.

---

## Architecture: How T3 Code Does It

```
                        T3 Code Server
                              |
                    query({ prompt, options })
                              |
               @anthropic-ai/claude-agent-sdk
                              |
                     spawns `claude` binary
                              |
                    reads ~/.claude/ creds
                              |
                      Anthropic API
```

### Key design decisions

1. **Single dependency**: `@anthropic-ai/claude-agent-sdk` (v0.2.77+). This is the only SDK surface used.
2. **Binary path is the only config**: The app stores `pathToClaudeCodeExecutable` and nothing else. No API keys, no tokens, no refresh logic.
3. **Environment passthrough**: `process.env` is forwarded to the SDK so the binary can read `ANTHROPIC_API_KEY` or other env vars if present.
4. **Two-tier auth probing** (cheapest first):
   - Tier 1: `claude auth status` CLI command (parse JSON stdout)
   - Tier 2: Zero-cost SDK probe via `query()` with `maxTurns: 0` + `initializationResult()`
5. **Subscription-aware model gating**: Subscription type (max, pro, free, enterprise, team) controls which context windows and models are surfaced.

---

## SDK API Surface (What T3 Code Actually Uses)

### Imports

```typescript
import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
```

### The `query()` Function

The entire integration pivots on a single function:

```typescript
const runtime = query({
  prompt: asyncIterableOfUserMessages, // or a string for single-shot
  options: queryOptions,
});
```

This returns a `ClaudeQueryRuntime` (an `AsyncIterable<SDKMessage>` with extra control methods):

```typescript
interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setMaxThinkingTokens(n: number | null): Promise<void>;
  initializationResult(): Promise<{ account?: { subscriptionType?: string } }>;
  close(): void;
}
```

### Query Options (Full Shape Used by T3 Code)

```typescript
const queryOptions: ClaudeQueryOptions = {
  // Required: path to the `claude` binary
  pathToClaudeCodeExecutable: "/usr/local/bin/claude",

  // Working directory for tool execution
  cwd: "/path/to/project",

  // Model selection (API model ID)
  model: "claude-sonnet-4-6-20250514",

  // Which settings files the CLI should load
  settingSources: ["user", "project", "local"] as SettingSource[],

  // Reasoning effort: "low" | "medium" | "high" | "max"
  effort: "high",

  // Permission mode for tool use
  permissionMode: "bypassPermissions", // or "plan"
  allowDangerouslySkipPermissions: true, // required when bypassPermissions

  // Session management
  sessionId: "new-session-uuid", // for new sessions
  resume: "existing-session-uuid", // to resume

  // Streaming control
  includePartialMessages: true,

  // Tool permission callback
  canUseTool: async (toolName, toolInput, options) => {
    // Return { behavior: "allow" } or { behavior: "deny", reason: "..." }
    return { behavior: "allow" };
  },

  // Environment inheritance (critical for auth)
  env: process.env,

  // Additional directories the agent can access
  additionalDirectories: ["/path/to/project"],

  // Settings overrides
  settings: {
    alwaysThinkingEnabled: true,
    fastMode: false,
  },
};
```

### Consuming the Message Stream

T3 Code iterates the async iterable and dispatches on `message.type`:

```typescript
for await (const message of runtime) {
  switch (message.type) {
    case "stream_event": // Raw API streaming delta
    case "assistant": // Complete assistant message
    case "result": // Final turn result (SDKResultMessage)
    case "system": // System message
    case "user": // User message echo
    case "tool_progress": // Tool execution progress
    case "tool_use_summary": // Tool summary
    case "auth_status": // Live auth status change
    case "rate_limit_event": // Rate limit notification
  }
}
```

The `result` message is a discriminated union keyed on `subtype`:

```typescript
type SDKResultMessage = SDKResultSuccess | SDKResultError;

type SDKResultSuccess = {
  type: "result";
  subtype: "success";
  result: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
  session_id: string;
};

type SDKResultError = {
  type: "result";
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  errors: string[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
  session_id: string;
};
```

---

## Auth Probing (How T3 Code Detects Auth State)

### Tier 1: CLI Status Check

T3 Code uses `execFile` (not `exec`) to avoid shell injection, running the `claude`
binary directly with argument arrays:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Step 1: Check if claude is installed
const { stdout: version } = await execFileAsync("claude", ["--version"], { timeout: 10_000 });

// Step 2: Check auth status
const { stdout: authOutput } = await execFileAsync("claude", ["auth", "status"], {
  timeout: 15_000,
});
```

> **OpenClaw note**: Prefer `execFileNoThrow` from `src/utils/execFileNoThrow.ts` instead
> of raw `execFile`. It handles Windows compatibility and returns structured output.

Parse the JSON output for:

```typescript
// Unauthenticated signals (case-insensitive substring match)
const UNAUTHENTICATED_PATTERNS = ["not logged in", "login required", "run `claude login`"];

// Subscription type extraction (recursive JSON walker)
const SUBSCRIPTION_TYPE_KEYS = ["subscriptionType", "subscription_type", "planType", "plan_type"];

// Auth method detection
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"];
// Values: "apiKey" | "subscription"
```

### Tier 2: Zero-Cost SDK Probe (Fallback)

When the CLI output doesn't include subscription info, T3 Code spawns a throwaway SDK session:

```typescript
async function probeClaudeCapabilities(binaryPath: string) {
  const abort = new AbortController();

  const q = query({
    prompt: ".",
    options: {
      persistSession: false,
      pathToClaudeCodeExecutable: binaryPath,
      abortController: abort,
      maxTurns: 0, // Never sends anything to the API
      settingSources: [], // Don't load any settings
      allowedTools: [], // No tools
      stderr: () => {}, // Suppress stderr
    },
  });

  // This resolves after local init, before any API call
  const init = await q.initializationResult();
  abort.abort();

  return {
    subscriptionType: init.account?.subscriptionType,
    // "max" | "pro" | "free" | "enterprise" | "team" | undefined
  };
}
```

**Why this works**: The SDK performs local initialization (reading `~/.claude/`, validating credentials) before sending any prompts to the API. With `maxTurns: 0`, it never makes an API call. The `initializationResult()` promise resolves with account metadata from the local credential file.

---

## Mapping to OpenClaw

### Where This Fits

OpenClaw's existing Anthropic provider (`extensions/anthropic/`) uses `@anthropic-ai/sdk` for direct API calls. The SDK-delegation approach is a different paradigm: instead of making API calls with credentials, you delegate to the `claude` binary.

Two integration strategies:

#### Strategy A: New Auth Method on Existing Provider (Recommended)

Add a `cli-delegation` auth method to the Anthropic provider in `extensions/anthropic/register.runtime.ts`. This keeps the existing API-key and OAuth paths but adds a third path that delegates to the CLI.

**Fits into**:

- `extensions/anthropic/register.runtime.ts` (new auth method registration)
- New file: `extensions/anthropic/cli-delegation.ts` (SDK wrapper)
- `src/agents/` (auth profile resolution)

#### Strategy B: Separate Provider Extension

Create `extensions/claude-agent/` as a standalone provider that wraps the SDK. This is a clean separation but duplicates model catalogs.

### Recommended File Structure (Strategy A)

```
extensions/anthropic/
  cli-delegation.ts          # SDK query() wrapper + stream adapter
  cli-delegation.probe.ts    # Auth probing (CLI + SDK init)
  cli-delegation.types.ts    # Types for SDK integration
  register.runtime.ts        # (modify) Add cli-delegation auth method
```

---

## Implementation Guide

### Step 1: Add the SDK Dependency

```bash
# In the project root (or the workspace that builds the server)
pnpm add @anthropic-ai/claude-agent-sdk
```

### Step 2: Auth Probing Module

Create `extensions/anthropic/cli-delegation.probe.ts`:

```typescript
import { execFileNoThrow } from "../../src/utils/execFileNoThrow.js";

export type ClaudeCliStatus =
  | { installed: false }
  | { installed: true; authenticated: false; reason: string }
  | {
      installed: true;
      authenticated: true;
      subscriptionType?: string;
      authMethod?: "apiKey" | "subscription";
    };

const UNAUTH_PATTERNS = ["not logged in", "login required", "run `claude login`"];
const SUB_KEYS = ["subscriptionType", "subscription_type", "planType", "plan_type"];
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"];

/**
 * Recursively walk an unknown JSON structure looking for a key.
 */
function findDeep(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k) && typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
    const deep = findDeep(v, keys);
    if (deep) return deep;
  }
  return undefined;
}

export async function probeClaudeCliStatus(binaryPath = "claude"): Promise<ClaudeCliStatus> {
  // 1. Check installation
  const versionResult = await execFileNoThrow(binaryPath, ["--version"]);
  if (versionResult.status !== 0) {
    return { installed: false };
  }

  // 2. Check auth status
  const authResult = await execFileNoThrow(binaryPath, ["auth", "status"]);
  if (authResult.status !== 0) {
    return { installed: true, authenticated: false, reason: "status_check_failed" };
  }

  const stdout = authResult.stdout;
  const lower = stdout.toLowerCase();

  // Check for unauthenticated signals
  if (UNAUTH_PATTERNS.some((p) => lower.includes(p))) {
    return { installed: true, authenticated: false, reason: "not_logged_in" };
  }

  // Try to parse as JSON for subscription info
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Non-JSON output but no unauthenticated signal = likely OK
    return { installed: true, authenticated: true };
  }

  return {
    installed: true,
    authenticated: true,
    subscriptionType: findDeep(parsed, SUB_KEYS),
    authMethod: findDeep(parsed, AUTH_METHOD_KEYS) as "apiKey" | "subscription" | undefined,
  };
}

/**
 * Zero-cost SDK probe: spawns claude binary, reads initializationResult(),
 * then immediately aborts. No API tokens consumed.
 *
 * Use as a fallback when `claude auth status` doesn't include subscription info.
 */
export async function probeClaudeCapabilities(
  binaryPath = "claude",
): Promise<{ subscriptionType?: string } | null> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const abort = new AbortController();
    const timeoutId = setTimeout(() => abort.abort(), 30_000);

    try {
      const q = query({
        prompt: ".",
        options: {
          persistSession: false,
          pathToClaudeCodeExecutable: binaryPath,
          abortController: abort,
          maxTurns: 0,
          settingSources: [],
          allowedTools: [],
          stderr: () => {},
        },
      });

      const init = await q.initializationResult();
      abort.abort();
      return { subscriptionType: init.account?.subscriptionType };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return null;
  }
}
```

### Step 3: SDK Session Wrapper

Create `extensions/anthropic/cli-delegation.ts`:

```typescript
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage,
  PermissionMode,
  PermissionResult,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSessionConfig {
  binaryPath: string;
  cwd: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  newSessionId?: string;
  settingSources?: SettingSource[];
  canUseTool?: (
    toolName: string,
    toolInput: unknown,
    options: unknown,
  ) => Promise<PermissionResult>;
}

export interface ClaudeSessionHandle {
  /** Async iterable of SDK messages */
  messages: AsyncIterable<SDKMessage>;
  /** Interrupt the current turn */
  interrupt(): Promise<void>;
  /** Switch model mid-session */
  setModel(model?: string): Promise<void>;
  /** Change permission mode */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Shut down the session */
  close(): void;
}

/**
 * Creates a Claude session by delegating to the Claude CLI via the Agent SDK.
 *
 * Authentication is handled entirely by the CLI binary. The calling code
 * does NOT need to provide API keys, OAuth tokens, or any credentials.
 * The CLI reads them from ~/.claude/.
 */
export function createClaudeSession(
  config: ClaudeSessionConfig,
  prompt: string | AsyncIterable<SDKUserMessage>,
): ClaudeSessionHandle {
  const options: ClaudeQueryOptions = {
    pathToClaudeCodeExecutable: config.binaryPath,
    cwd: config.cwd,
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(config.permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
    ...(config.newSessionId ? { sessionId: config.newSessionId } : {}),
    settingSources: config.settingSources ?? ["user", "project", "local"],
    includePartialMessages: true,
    canUseTool: config.canUseTool ?? (async () => ({ behavior: "allow" as const })),
    env: process.env,
    ...(config.cwd ? { additionalDirectories: [config.cwd] } : {}),
  };

  const runtime = query({ prompt, options });

  return {
    messages: runtime,
    interrupt: () => runtime.interrupt(),
    setModel: (model) => runtime.setModel(model),
    setPermissionMode: (mode) => runtime.setPermissionMode(mode),
    close: () => runtime.close(),
  };
}
```

### Step 4: Stream Adapter

The SDK emits `SDKMessage` objects. OpenClaw expects its own message format. Create an adapter:

```typescript
// extensions/anthropic/cli-delegation.stream-adapter.ts

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type AdaptedMessage =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "result"; status: string; usage?: TokenUsage }
  | { kind: "auth_status"; authenticated: boolean }
  | { kind: "rate_limit"; retryAfterMs?: number }
  | { kind: "ignored" };

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
};

export function adaptSdkMessage(msg: SDKMessage): AdaptedMessage {
  switch (msg.type) {
    case "stream_event": {
      // Raw streaming event from the Anthropic API.
      // Shape varies; extract text deltas from content_block_delta events.
      const event = msg as Record<string, unknown>;
      if (event.event === "content_block_delta") {
        const delta = (event.data as Record<string, unknown>)?.delta as Record<string, unknown>;
        if (delta?.type === "text_delta") {
          return { kind: "text_delta", text: delta.text as string };
        }
        if (delta?.type === "thinking_delta") {
          return { kind: "thinking_delta", text: delta.thinking as string };
        }
      }
      return { kind: "ignored" };
    }

    case "assistant": {
      // Complete assistant message (arrives after stream finishes).
      // Contains the full content blocks. Useful for non-streaming consumers.
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            return { kind: "text_delta", text: block.text };
          }
        }
      }
      return { kind: "ignored" };
    }

    case "result": {
      const result = msg as unknown as SDKResultMessage;
      return {
        kind: "result",
        status: result.subtype,
        usage: {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          cacheReadTokens: result.usage.cache_read_input_tokens,
        },
      };
    }

    case "auth_status":
      return {
        kind: "auth_status",
        authenticated: (msg as Record<string, unknown>).authenticated === true,
      };

    case "rate_limit_event":
      return {
        kind: "rate_limit",
        retryAfterMs: (msg as Record<string, unknown>).retryAfterMs as number | undefined,
      };

    default:
      return { kind: "ignored" };
  }
}
```

### Step 5: Register as Auth Method in Anthropic Provider

Modify `extensions/anthropic/register.runtime.ts` to add CLI delegation:

```typescript
// In the auth array of api.registerProvider():
{
  id: "cli",
  label: "Claude Code CLI (delegation)",
  hint: "Delegates to your existing `claude` CLI login. No API key needed.",
  kind: "token", // From OpenClaw's perspective, this is token-like
  wizard: {
    choiceId: "cli-delegation",
    choiceLabel: "Claude Code CLI",
    choiceHint: "Uses your existing `claude login` session",
    assistantPriority: 10, // Prefer this if available
    groupId: "anthropic",
    groupLabel: "Anthropic",
    groupHint: "CLI delegation + API key + legacy token",
  },
  run: async (ctx) => {
    const { probeClaudeCliStatus } = await import("./cli-delegation.probe.js");
    const status = await probeClaudeCliStatus(ctx.opts?.binaryPath ?? "claude");

    if (!status.installed) {
      throw new Error(
        "Claude CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code"
      );
    }
    if (!status.authenticated) {
      throw new Error(
        "Claude CLI is not authenticated. Run `claude login` first."
      );
    }

    return {
      profiles: [{
        profileId: "anthropic:cli-delegation",
        credential: {
          type: "token" as const,
          provider: "anthropic",
          token: "__cli_delegation__", // Sentinel; never sent to API
          expires: undefined, // CLI manages its own expiry
        },
      }],
      defaultModel: "anthropic/claude-sonnet-4-6",
      notes: [
        "Using Claude Code CLI delegation. Auth is managed by the `claude` binary.",
        "Run `claude login` if you need to re-authenticate.",
      ],
    };
  },
},
```

---

## How Credentials Flow (End to End)

```
User runs `claude login`
         |
         v
~/.claude/.credentials.json is written by the CLI
  {
    "claudeAiOauth": {
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": 1712345678000,
      "subscriptionType": "max",
      "rateLimitTier": "t4"
    }
  }
         |
         v
OpenClaw starts, probes:
  1. `claude auth status` -> JSON with subscription info
  2. (fallback) SDK probe -> initializationResult().account
         |
         v
User sends message via OpenClaw
         |
         v
OpenClaw calls: query({ prompt, options: { pathToClaudeCodeExecutable, env, ... } })
         |
         v
SDK spawns: `claude` subprocess
         |
         v
Claude binary reads ~/.claude/.credentials.json
  - Validates token expiry
  - Refreshes if needed (automatic)
  - Opens connection to Anthropic API
         |
         v
SDK returns: AsyncIterable<SDKMessage>
         |
         v
OpenClaw adapts messages to its own format and streams to client
```

### What OpenClaw Stores

| Data                    | Stored?          | Where                           |
| ----------------------- | ---------------- | ------------------------------- |
| `claude` binary path    | Yes              | Config YAML or env var          |
| API keys / OAuth tokens | **No**           | Managed by CLI in `~/.claude/`  |
| Subscription type       | Cached in memory | Probed at startup, TTL ~5 min   |
| Session IDs             | Yes              | Auth profile store (for resume) |

### What OpenClaw Does NOT Need to Handle

- Token refresh (the CLI does it)
- OAuth flows (the CLI does it)
- Credential encryption (the CLI does it)
- Rate limit backoff on auth failures (the SDK handles it)

---

## Edge Cases and Operational Notes

### 1. CLI Not Installed

Probe returns `{ installed: false }`. Surface a clear message pointing to install docs. Do not fall through to API-key auth silently.

### 2. CLI Installed but Not Logged In

Probe returns `{ authenticated: false }`. Tell the user to run `claude login`. The `auth_status` message type can also arrive mid-session if auth expires.

### 3. Token Expiry Mid-Session

The SDK emits an `auth_status` message when the CLI's token expires during a session. Handle this by surfacing a re-auth prompt. The CLI may auto-refresh in the background; watch for a follow-up `auth_status` with `authenticated: true`.

### 4. Subscription Tier Detection

Subscription type affects available models and context windows:

| Subscription | Default Context | Notes                        |
| ------------ | --------------- | ---------------------------- |
| max          | 1M tokens       | Full model access            |
| enterprise   | 1M tokens       | Full model access            |
| team         | 1M tokens       | Full model access            |
| pro          | 200k tokens     | 1M available but not default |
| free         | 200k tokens     | Limited rate limits          |

### 5. Permission Mode

T3 Code supports two modes:

- `"bypassPermissions"`: Auto-approve all tool use (requires `allowDangerouslySkipPermissions: true`)
- `"plan"`: Show proposed actions for user approval

OpenClaw should map this to its existing approval UX. The `canUseTool` callback is where you bridge between the SDK's permission model and OpenClaw's.

### 6. Session Resume

The SDK supports session resume via the `resume` option. Store the `sessionId` from the `result` message and pass it back on reconnect:

```typescript
// Starting a new session
query({ prompt, options: { sessionId: crypto.randomUUID() } });

// Resuming
query({ prompt, options: { resume: previousSessionId } });
```

### 7. `process.env` Passthrough

The SDK receives `env: process.env`. This means:

- `ANTHROPIC_API_KEY` in the environment will be picked up by the CLI
- `CLAUDE_CODE_*` env vars affect CLI behavior
- OpenClaw should document which env vars flow through

### 8. Multiple Concurrent Sessions

Each `query()` call spawns a separate `claude` subprocess. They share the same `~/.claude/` credentials but are otherwise independent. Rate limits are enforced server-side by Anthropic.

---

## Comparison with OpenClaw's Existing Auth Paths

| Aspect             | API Key (`@anthropic-ai/sdk`) | CLI Delegation (`claude-agent-sdk`) |
| ------------------ | ----------------------------- | ----------------------------------- |
| Credential storage | OpenClaw auth-profiles store  | `~/.claude/` (CLI-managed)          |
| Token refresh      | OpenClaw handles              | CLI handles                         |
| Billing            | Per-token API billing         | Subscription-based (if Max/Pro)     |
| Setup cost         | User pastes API key           | User runs `claude login`            |
| Rate limits        | API tier limits               | Subscription tier limits            |
| Model access       | All API models                | Subscription-gated                  |
| Offline probe      | Instant (key exists)          | Requires CLI spawn                  |
| Multi-user         | Each user has own key         | Each user has own CLI login         |

### When to Use Which

- **API key path**: Production deployments, team environments, pay-per-token billing
- **CLI delegation**: Personal use, development, Claude Max subscribers who want flat-rate billing

---

## Testing Checklist

- [ ] `claude --version` succeeds with configured binary path
- [ ] `claude auth status` returns authenticated state
- [ ] `probeClaudeCapabilities()` returns subscription type without consuming tokens
- [ ] `createClaudeSession()` successfully streams a response
- [ ] `auth_status` message is handled when token expires mid-session
- [ ] `rate_limit_event` message is surfaced to the user
- [ ] Session resume works after disconnect
- [ ] `interrupt()` stops the current turn cleanly
- [ ] `close()` terminates the subprocess
- [ ] Fallback to API-key auth works when CLI is not installed
- [ ] Multiple concurrent sessions don't interfere with each other

---

## Reference Files (T3 Code)

| File                                                  | Purpose                                                      | Lines |
| ----------------------------------------------------- | ------------------------------------------------------------ | ----- |
| `apps/server/src/provider/Layers/ClaudeProvider.ts`   | Auth probing, subscription detection, status check           | ~650  |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`    | SDK session management, message handling, stream consumption | ~2900 |
| `apps/server/src/provider/Services/ClaudeProvider.ts` | Service interface for provider status                        | ~50   |
| `apps/server/src/provider/Services/ClaudeAdapter.ts`  | Service interface for adapter                                | ~50   |
| `packages/contracts/src/settings.ts`                  | `ClaudeSettings` schema (binaryPath, enabled)                | ~200  |

### T3 Code SDK Version

```json
{
  "@anthropic-ai/claude-agent-sdk": "^0.2.77"
}
```

---

## Reference Files (OpenClaw, Existing)

| File                                               | Relevance                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `extensions/anthropic/register.runtime.ts`         | Where to add the new auth method                                            |
| `extensions/anthropic/stream-wrappers.ts`          | Existing stream adaptation (for reference)                                  |
| `src/agents/auth-profiles/types.ts`                | Auth credential types to conform to                                         |
| `src/agents/auth-profiles/oauth.ts`                | Existing OAuth flow (for comparison)                                        |
| `src/commands/doctor-auth-anthropic-claude-cli.ts` | Existing CLI migration code (has `claude-cli` provider ID being deprecated) |
| `scripts/claude-auth-status.sh`                    | Existing auth status script (reads `~/.claude/.credentials.json`)           |
| `src/gateway/auth.ts`                              | Gateway auth system (not directly related, but shows the pattern)           |
| `src/utils/execFileNoThrow.ts`                     | Safe subprocess execution utility (use instead of raw `execFile`)           |
