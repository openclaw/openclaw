# Clawdbot: CLI vs Embedded Agent Architecture Analysis

## Executive Summary

This document provides a technical comparison of the two agent execution paths in Clawdbot:
1. **Embedded Path** - Direct API calls to Anthropic/OpenAI/Google
2. **CLI Path** - Subprocess invocation of claude-cli, codex-cli, etc.

**Key Finding:** The CLI path is significantly under-implemented compared to the embedded path. Multiple critical features are either missing or incorrectly handled, leading to degraded agent behavior.

---

## Architecture Overview

### Entry Point & Branching

**File:** `src/auto-reply/reply/agent-runner-execution.ts`

```typescript
// Line 157 - The branching decision
if (isCliProvider(provider, params.followupRun.run.config)) {
  return runCliAgent({...});  // CLI PATH
}
return runEmbeddedPiAgent({...});  // EMBEDDED PATH
```

### Execution Flow Comparison

| Phase | Embedded Path | CLI Path |
|-------|--------------|----------|
| Entry | `runEmbeddedPiAgent()` | `runCliAgent()` |
| System Prompt | `buildEmbeddedSystemPrompt()` | `buildSystemPrompt()` |
| Tools | Full `AgentTool[]` via SDK | `tools: []` (disabled) |
| Context Files | Injected as SDK context + in prompt | In prompt only |
| Session | `SessionManager` (mariozechner) | CLI `--session-id` / `--resume` |
| Execution | SDK streaming | Subprocess with timeout |

---

## Critical Issues Found

### 1. 🔴 System Prompt NOT Sent on Resume

**Location:** `src/agents/cli-runner/helpers.ts:422`

```typescript
if (!params.useResume && params.systemPrompt && params.backend.systemPromptArg) {
  args.push(params.backend.systemPromptArg, params.systemPrompt);
}
```

**Problem:** When `useResume=true`, the system prompt (including ALL workspace context like TOOLS.md, AGENTS.md) is **not passed to the CLI**.

**Impact:** On resumed sessions (heartbeats, follow-up messages), the agent has no access to:
- Workspace instructions (AGENTS.md)
- Tool documentation (TOOLS.md)
- Memory files (MEMORY.md)
- Identity (SOUL.md, IDENTITY.md)
- Heartbeat instructions (HEARTBEAT.md)

**Backend Config:**
```typescript
// src/agents/cli-backends.ts:46-48
systemPromptArg: "--append-system-prompt",
systemPromptMode: "append",
systemPromptWhen: "first",  // <-- Only on FIRST message!
```

**Root Cause:** `systemPromptWhen: "first"` combined with `resolveSystemPromptUsage()` returning `null` for non-new sessions means context is only injected on session creation.

### 2. 🔴 Tools Explicitly Disabled

**Location:** `src/agents/cli-runner.ts:66-71`

```typescript
const extraSystemPrompt = [
  params.extraSystemPrompt?.trim(),
  "Tools are disabled in this session. Do not call tools.",  // <-- Hardcoded!
]
```

**And:** `src/agents/cli-runner.ts:103`

```typescript
const systemPrompt = buildSystemPrompt({
  // ...
  tools: [],  // <-- Empty array!
  // ...
});
```

**Impact:** The CLI path fundamentally cannot use Clawdbot's tool system:
- No `exec` (shell commands)
- No `read/write/edit` (file operations)
- No `message` (send messages)
- No `web_search/web_fetch`
- No `browser`, `canvas`, `nodes`
- No `memory_search/memory_get`
- No `tts`, `image`, `cron`

**Embedded Path Comparison:** Gets full tool suite via `createClawdbotCodingTools()`:
```typescript
// src/agents/pi-embedded-runner/run/attempt.ts:202-232
const tools = createClawdbotCodingTools({
  exec: { ... },
  sandbox,
  sessionKey,
  agentDir,
  workspaceDir,
  config,
  // ... full tool configuration
});
```

### 3. 🟡 Context Injection Differences

**Embedded Path:**
```typescript
// Context loaded via resolveBootstrapContextForRun()
// Passed to SDK as separate contextFiles parameter
// Also injected into system prompt text
```

**CLI Path:**
```typescript
// Context loaded (same function)
// BUT only injected into system prompt text
// AND only on first message (systemPromptWhen: "first")
```

**The CLI path DOES load context files correctly** - they go through `resolveBootstrapContextForRun()`. But they're only useful on the first message because of the `systemPromptWhen` setting.

### 4. 🟡 Session Management Asymmetry

**Embedded Path:**
- Uses `SessionManager` from `@mariozechner/pi-coding-agent`
- Full conversation history management
- Compaction support
- Transcript persistence

**CLI Path:**
- Relies entirely on Claude Code's internal session management
- Session ID passed via `--session-id` (new) or `--resume` (existing)
- No access to session internals
- Manual transcript persistence added via patches

### 5. 🟡 No Streaming Support

**Embedded Path:**
```typescript
// Uses streamSimple() for real-time token streaming
// Events emitted: "assistant", "thinking", "tool_use", etc.
```

**CLI Path:**
```typescript
// Subprocess with timeout, output buffered
// Only get result after CLI exits
// No intermediate events
```

---

## Feature Comparison Matrix

| Feature | Embedded | CLI | Gap Severity |
|---------|----------|-----|--------------|
| System Prompt (first msg) | ✅ | ✅ | - |
| System Prompt (resume) | ✅ | ❌ | 🔴 Critical |
| Workspace Context (first) | ✅ | ✅ | - |
| Workspace Context (resume) | ✅ | ❌ | 🔴 Critical |
| Tools (exec, read, write) | ✅ | ❌ | 🔴 Critical |
| Tools (message, browser) | ✅ | ❌ | 🔴 Critical |
| Session History | ✅ SDK | ✅ CLI-managed | 🟢 OK |
| Streaming Output | ✅ | ❌ | 🟡 Medium |
| Thinking/Reasoning | ✅ | ✅ (via CLI) | 🟢 OK |
| Image Input | ✅ | ✅ | 🟢 OK |
| Timeout Handling | ✅ | ✅ | 🟢 OK |
| Error Recovery | ✅ | ⚠️ Basic | 🟡 Medium |
| Usage Tracking | ✅ | ⚠️ Parsed from output | 🟢 OK |

---

## Code Paths Deep Dive

### Embedded Path: Full Context Flow

```
getReplyFromConfig()
  └─> runPreparedReply()
      └─> runAgentTurnWithFallback()
          └─> runEmbeddedPiAgent()
              └─> resolveBootstrapContextForRun()  ✅ Load context
              └─> createClawdbotCodingTools()      ✅ Create tools
              └─> buildEmbeddedSystemPrompt()      ✅ Build prompt with context
              └─> createAgentSession()             ✅ Pass tools + context to SDK
              └─> subscribeEmbeddedPiSession()     ✅ Stream execution
```

### CLI Path: Incomplete Flow

```
getReplyFromConfig()
  └─> runPreparedReply()
      └─> runAgentTurnWithFallback()
          └─> runCliAgent()
              └─> resolveBootstrapContextForRun()  ✅ Load context
              └─> tools: []                        ❌ No tools
              └─> buildSystemPrompt()              ⚠️ Context in prompt
              └─> resolveSystemPromptUsage()       ❌ Returns null if !isNew
              └─> buildCliArgs()                   ❌ Skips prompt if useResume
              └─> runCommandWithTimeout()          ⚠️ Just subprocess
```

---

## Recommendations

### Immediate Fixes (High Priority)

1. **Always inject workspace context on CLI resume**
   - Change `systemPromptWhen: "first"` to `"always"` for claude-cli
   - Or implement separate context injection mechanism
   - Without this, resumed sessions have NO agent identity/instructions

2. **Remove hardcoded "Tools are disabled" message**
   - This is misleading - Claude Code has its OWN tools
   - Should instead document which tools are available

3. **Consider hybrid approach**
   - Use Clawdbot's tool system alongside Claude Code
   - Or properly document that CLI mode delegates ALL tool execution to the CLI

### Medium-Term Improvements

4. **Add context injection flag to resumeArgs**
   - Claude Code supports `--append-system-prompt` even with `--resume`
   - Need to restructure `buildCliArgs()` to include it

5. **Implement streaming for CLI**
   - Claude Code supports `--output-format stream-json`
   - Would enable real-time output and better UX

6. **Unify session transcript management**
   - Current patches add transcript writes but it's fragile
   - Should have consistent approach across both paths

### Architecture Decision Required

The fundamental question: **What is the CLI path supposed to be?**

**Option A: Thin Wrapper**
- CLI handles everything (tools, context, session)
- Clawdbot just routes messages and parses output
- Current implementation is close to this, but broken

**Option B: Full Integration**
- Clawdbot manages context, tools, session
- CLI is just the execution engine
- Would require significant rework

**Option C: Hybrid**
- Clawdbot injects context and handles some tools
- CLI handles others via its native capabilities
- Most flexible but most complex

---

## Files Reference

### Core Branching
- `src/auto-reply/reply/agent-runner-execution.ts` - Main execution router

### Embedded Path
- `src/agents/pi-embedded-runner/run.ts` - Orchestrator
- `src/agents/pi-embedded-runner/run/attempt.ts` - Actual execution
- `src/agents/pi-tools.ts` - Tool creation

### CLI Path
- `src/agents/cli-runner.ts` - Main CLI executor
- `src/agents/cli-runner/helpers.ts` - Arg building, parsing
- `src/agents/cli-backends.ts` - Backend configs

### Shared
- `src/agents/system-prompt.ts` - Core prompt building
- `src/agents/bootstrap-files.ts` - Context file loading
- `src/agents/workspace.ts` - Workspace scanning

---

## Appendix: Current Backend Config

```typescript
// src/agents/cli-backends.ts
const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: "claude",
  args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
  resumeArgs: [
    "-p",
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--resume", "{sessionId}",
  ],
  output: "json",
  input: "arg",
  modelArg: "--model",
  sessionArg: "--session-id",
  sessionMode: "always",
  systemPromptArg: "--append-system-prompt",
  systemPromptMode: "append",
  systemPromptWhen: "first",  // <-- THE PROBLEM
  clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],
  serialize: true,
};
```

---

## Token Tracking & Usage Parsing

### Issue: Incorrect Token Display (CLI Path)

**Symptom:** Token display showing `2.1m/200k (999%)` instead of actual context usage (~85k).

### Root Cause Analysis

#### 1. CLI `toUsage()` Missing `cache_creation_input_tokens`

**Location:** `src/agents/cli-runner/helpers.ts:229-240`

```typescript
function toUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? (raw[key] as number) : undefined;
  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ?? pick("cached_input_tokens") ?? pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");  // ❌ MISSING cache_creation_input_tokens
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}
```

**Problem:** Claude Code returns `cache_creation_input_tokens`, but `toUsage()` only checks for `cache_write_input_tokens`. This means `cacheWrite` is always `undefined` for CLI calls.

**Compare to `normalizeUsage()` in `src/agents/usage.ts:59-62` (used by embedded path):**
```typescript
const cacheWrite = asFiniteNumber(
  raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,  // ✅ Handles all variants
);
```

#### 2. Anthropic Cache Token Semantics

Claude's API returns these usage fields:
```json
{
  "usage": {
    "input_tokens": 3,                      // New uncached tokens
    "cache_read_input_tokens": 85000,       // Tokens loaded from cache
    "cache_creation_input_tokens": 500,     // Tokens newly cached THIS request
    "output_tokens": 100
  }
}
```

**Key insight:** `cache_creation_input_tokens` is a **subset** of the input that was cached, NOT additional tokens.

**Correct context window usage:** `input_tokens + cache_read_input_tokens`
**What clawdbot calculates:** `input + cacheRead + cacheWrite` (double-counting if cacheWrite parsed)

#### 3. Token Persistence Flow

**File:** `src/auto-reply/reply/session-usage.ts:30-38`

```typescript
update: async (entry) => {
  const input = params.usage?.input ?? 0;
  const output = params.usage?.output ?? 0;
  const promptTokens =
    input + (params.usage?.cacheRead ?? 0) + (params.usage?.cacheWrite ?? 0);
  const patch: Partial<SessionEntry> = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: promptTokens > 0 ? promptTokens : (params.usage?.total ?? input),
    // ...
  };
```

This **overwrites** `totalTokens` (doesn't accumulate), but the formula adds `cacheWrite` which would be incorrect for context display.

#### 4. Status Display Reading

**File:** `src/auto-reply/status.ts:297-315`

```typescript
let totalTokens = entry?.totalTokens ?? (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0);

if (args.includeTranscriptUsage) {
  const logUsage = readUsageFromSessionLog(entry?.sessionId, entry);
  if (logUsage) {
    const candidate = logUsage.promptTokens || logUsage.total;
    if (!totalTokens || totalTokens === 0 || candidate > totalTokens) {
      totalTokens = candidate;  // Override if transcript has higher value
    }
  }
}
```

`readUsageFromSessionLog()` reads the clawdbot session transcript and can override the stored `totalTokens` if the transcript value is higher.

### Observed Token Values

**From sessions.json:**
```json
{
  "inputTokens": 32,
  "outputTokens": 5574,
  "totalTokens": 2080469,   // ❌ Wildly incorrect
  "contextTokens": 200000   // ✅ Correct (model context window)
}
```

**From Claude Code session (typical recent call):**
```json
{
  "input_tokens": 1,
  "cache_creation_input_tokens": 500,
  "cache_read_input_tokens": 85000,
  "output_tokens": 100
}
```

**Expected totalTokens:** ~85,001 (input + cacheRead)
**Actual totalTokens:** 2,080,469 (source unclear - appears to be accumulation)

### Cumulative Sums from Claude Code Session

Analysis of all 418 API calls in current session:
- Total `input_tokens`: 492
- Total `cache_creation_input_tokens`: 2,801,000
- Total `cache_read_input_tokens`: 22,240,078
- Cumulative `cache_read` at entry 68: ~2,051,411 (close to displayed 2,080,469)

This suggests the 2.08M value may be coming from cumulative `cache_read_input_tokens` being summed somewhere rather than using the latest value.

### Comparison: Embedded vs CLI Token Handling

| Aspect | Embedded Path | CLI Path |
|--------|--------------|----------|
| Usage Parsing | `normalizeUsage()` ✅ | `toUsage()` ❌ |
| Handles `cache_creation_input_tokens` | ✅ Yes | ❌ No |
| Usage Source | SDK response | Parsed CLI JSON |
| Accumulation Risk | Low (SDK manages) | Higher (manual parsing) |

### Recommended Fixes

#### Fix 1: Add `cache_creation_input_tokens` to CLI `toUsage()`

```typescript
// In src/agents/cli-runner/helpers.ts:236
const cacheWrite =
  pick("cache_write_input_tokens") ??
  pick("cache_creation_input_tokens") ??  // ADD THIS
  pick("cacheWrite");
```

#### Fix 2: Correct Context Display Formula

For **context window display**, use:
```typescript
const contextUsed = input + cacheRead;  // NOT + cacheWrite
```

For **billing/total tokens**:
```typescript
const billedTokens = input + cacheRead + cacheWrite;  // All tokens processed
```

#### Fix 3: Investigate Accumulation Source

The 2.08M value's exact source is still unclear. Possibilities:
- Bug in `readUsageFromSessionLog()` accumulating across transcript entries
- Issue with how clawdbot transcript stores CLI usage
- Race condition in `updateSessionStoreEntry()`

---

## Session Compaction Coordination

### Current Behavior

**Embedded Path:**
- Clawdbot's `SessionManager` handles compaction
- Pre-compaction memory flush supported
- Compaction settings configurable (`reserveTokens`, `keepRecentTokens`)
- See `docs/reference/session-management-compaction.md`

**CLI Path:**
- Claude Code handles its own compaction internally
- Clawdbot has **no visibility** into when CC compacts
- Memory flush explicitly skipped: "The flush runs only for embedded Pi sessions (CLI backends skip it)"

### Observed Compaction Event

From Claude Code session `e385fe53-2e2e-4533-ab27-3ee6bf708fae`:
```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "content": "Conversation compacted",
  "compactMetadata": {
    "trigger": "auto",
    "preTokens": 172423
  },
  "timestamp": "2026-01-26T09:55:06.386Z"
}
```

CC auto-compacted when context reached ~172k tokens (of 200k limit).

### Problem: Context Loss on CC Compaction

When Claude Code compacts:
1. System prompt (with TOOLS.md, AGENTS.md, etc.) may be summarized/compressed
2. Clawdbot is unaware this happened
3. Token counts in clawdbot's session store become stale
4. Agent loses detailed workspace context

### Potential Solutions

**Option A: Let CC manage compaction entirely**
- Current behavior, but track CC's compaction events
- Sync token counts after CC reports compaction
- Accept that clawdbot context gets compressed

**Option B: Disable CC compaction, clawdbot manages**
- Pass flag to disable CC auto-compact (if available)
- Clawdbot monitors context usage
- When threshold reached, clawdbot:
  1. Runs memory flush
  2. Starts NEW Claude Code session
  3. Injects fresh system prompt with full context
- Continue using `--resume` until next compaction trigger

**Option C: Hybrid coordination**
- Monitor CC session for compaction events
- After CC compacts, re-inject critical context via `--append-system-prompt`
- Requires detecting `compact_boundary` events in CC output

### Claude Code Compaction Triggers

Based on observed behavior and code analysis:
- **Auto-compact threshold:** `contextTokens > contextWindow - reserveTokens`
- **Default reserveTokens:** ~16k-20k tokens headroom
- **Trigger point for 200k context:** ~180k-184k tokens
- **Observed trigger:** 172,423 tokens (with some variance)

---

*Document generated: 2026-01-26*
*Analysis based on clawdbot version 2026.1.24-3*
*Updated: 2026-01-26 with token tracking and compaction analysis*
