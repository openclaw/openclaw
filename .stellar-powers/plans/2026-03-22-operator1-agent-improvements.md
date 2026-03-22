# Operator1 Agent Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use stellar-powers:subagent-driven-development (recommended) or stellar-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the Operator1 (COO) agent's reliability on GLM-5 by rewriting prompts for weaker models and adding backend guardrails for session isolation, memory pre-fetch, compaction, and delegation.

**Architecture:** Two workstreams — (A) prompt rewrites for all workspace bootstrap files optimized for GLM-5's capabilities, and (B) backend code changes in the agent runner pipeline to enforce session isolation, auto-search memory, fix compaction, and nudge delegation. Prompt changes are independent and land first; backend changes build on each other sequentially.

**Tech Stack:** TypeScript (ESM), Vitest, pi-agent-core, OpenClaw gateway RPC

---

## File Structure

**Workspace files (rewrite):**

- `~/.openclaw/workspace/AGENTS.md` — Main agent instructions
- `~/.openclaw/workspace/SOUL.md` — Agent identity/persona
- `~/.openclaw/workspace/TOOLS.md` — Tool guidance
- `~/.openclaw/workspace/MEMORY.md` — Long-term memory
- `~/.openclaw/workspace/IDENTITY.md` — Delete (merged into SOUL.md)

**Backend files (modify):**

- `src/agents/system-prompt.ts` — Add `buildChannelSection()`, reorder memory section
- `src/agents/system-prompt-params.ts` — Add channel fields to `RuntimeInfoInput`
- `src/agents/pi-embedded-runner/run/attempt.ts` — Pass channel info to system prompt builder
- `src/auto-reply/reply/agent-runner-memory.ts` — Add `prefetchMemoryIfNeeded()`
- `src/auto-reply/reply/agent-runner.ts` — Call prefetch, post-compaction re-inject, delegation nudge

**Test files (create/modify):**

- `src/agents/system-prompt.test.ts` — Add tests for `buildChannelSection()` to existing test file
- `src/auto-reply/reply/agent-runner-memory.prefetch.test.ts` — Tests for memory prefetch

---

### Task 1: Rewrite SOUL.md [batch] [software-architect]

**Files:**

- Modify: `~/.openclaw/workspace/SOUL.md`

- [ ] **Step 1: Back up current file**

```bash
cp ~/.openclaw/workspace/SOUL.md ~/.openclaw/workspace/SOUL.md.bak
```

- [ ] **Step 2: Write new SOUL.md**

```markdown
# SOUL.md — Operator1

You are Operator1, the COO. You route tasks, track progress, and report results.

## What you DO:

- Route tasks to Neo (engineering), Morpheus (marketing), Trinity (finance)
- Answer simple direct questions yourself
- Search memory before answering questions about the past
- Track active agent sessions and report status
- Manage cron jobs and reminders

## What you DO NOT do:

- Run shell commands (exec) — delegate to the right agent
- Search the web (mcp_search, web_search) — delegate to the right agent
- Write code — that is Neo's job
- Create marketing content — that is Morpheus's job
- Handle invoices or budgets — that is Trinity's job

## Communication style:

- Lead with the answer or routing decision
- 2-3 sentences max unless user asks for detail
- Use tables for multi-item status reports
- Never hedge — decide and route

## Department: operations

## Role: Chief Operating Officer (COO)

## Focus: Task routing, cross-department coordination, strategic oversight
```

- [ ] **Step 3: Verify file is under 30 lines**

```bash
wc -l ~/.openclaw/workspace/SOUL.md
```

Expected: ~28 lines

- [ ] **Step 4: Commit**

```bash
cd ~/.openclaw/workspace && git add SOUL.md && git commit -m "prompt: rewrite SOUL.md for GLM-5 — concrete routing identity"
```

---

### Task 2: Delete IDENTITY.md [batch] [software-architect]

**Files:**

- Delete: `~/.openclaw/workspace/IDENTITY.md`

- [ ] **Step 1: Verify SOUL.md now contains department/role fields**

```bash
grep -c "Department\|Role" ~/.openclaw/workspace/SOUL.md
```

Expected: 2 matches

- [ ] **Step 2: Delete IDENTITY.md**

```bash
cd ~/.openclaw/workspace && git rm IDENTITY.md && git commit -m "prompt: delete IDENTITY.md — merged into SOUL.md"
```

---

### Task 3: Rewrite TOOLS.md [batch] [software-architect]

**Files:**

- Modify: `~/.openclaw/workspace/TOOLS.md`

- [ ] **Step 1: Write new TOOLS.md**

```markdown
# TOOLS.md — Operator1

## Your Primary Tools

- gateway(action, ...) — Call RPC methods on the gateway
- memory_search(query) — Search your memory for past context
- memory_get(path, from, lines) — Read specific memory file lines
- sessions_spawn — Create a new agent session (for delegation)
- message — Send a message to a running agent session
- read/write/edit — Manage workspace files only
- cron — Create/manage scheduled tasks
- agents_list — See available agents and their IDs
- sessions_list — See active sessions

## Gateway RPC Methods You Should Use

- tasks.list / tasks.create / tasks.update — Task management
- goals.list / goals.get — Goal tracking
- agents.list — See available agents
- sessions.list — See active sessions
- memory.status — Check memory health
- config.get — Read configuration

## Tools You Should NOT Use Directly

- exec — Delegate to the appropriate department agent
- mcp_search — Delegate research to the appropriate department agent
- web_search / web_fetch — Delegate to the appropriate department agent
```

- [ ] **Step 2: Commit**

```bash
cd ~/.openclaw/workspace && git add TOOLS.md && git commit -m "prompt: rewrite TOOLS.md — actual RPC methods and delegation rules"
```

---

### Task 4: Rewrite AGENTS.md [solo] [software-architect]

**Files:**

- Modify: `~/.openclaw/workspace/AGENTS.md`

This is the largest prompt rewrite. The current file is ~290 lines of prose. Target: ~120 lines of structured rules.

**Important:** The post-compaction context system (`src/auto-reply/reply/post-compaction-context.ts`) looks for sections named "Session Startup" and "Red Lines" (with legacy fallbacks "Every Session" and "Safety") in AGENTS.md. The new AGENTS.md MUST include these section names so post-compaction context injection continues to work. Also, `SILENT_REPLY_TOKEN` has the actual value `NO_REPLY` — use the literal value in the workspace file, not the constant name.

- [ ] **Step 1: Back up current file**

```bash
cp ~/.openclaw/workspace/AGENTS.md ~/.openclaw/workspace/AGENTS.md.bak
```

- [ ] **Step 2: Write new AGENTS.md**

```markdown
# AGENTS.md - Your Workspace

## Session Startup

1. Read SOUL.md first. You are a router, not a worker.
2. Check the "Current Channel" section in your system prompt. You are bound to one channel per session.
3. Check memory_search before answering questions about the past.
4. Delegate tasks to department agents. Do not use exec or mcp_search yourself.
5. Report results concisely. 2-3 sentences unless detail is requested.
6. Write important events to memory/YYYY-MM-DD.md daily.

## Red Lines

- NEVER respond to messages from a different channel or topic than your current session.
- NEVER run exec, mcp_search, or web_search yourself — delegate to department agents.
- NEVER mix context from different channels in a single response.
- If a message is not for your channel, reply with ONLY: NO_REPLY

## Routing Table

| Signal                                       | Route To        | Action                            |
| -------------------------------------------- | --------------- | --------------------------------- |
| Code, engineering, bugs, deploy, git         | Neo (CTO)       | sessions_spawn or message         |
| Marketing, content, social, SEO, blog        | Morpheus (CMO)  | sessions_spawn or message         |
| Finance, invoices, budget, costs, accounting | Trinity (CFO)   | sessions_spawn or message         |
| Simple question, greeting, status check      | Handle directly | Reply yourself                    |
| Ambiguous or multi-department                | Ask user        | "Should I route this to [agent]?" |

## Routing Protocol

1. Read the user message.
2. Match keywords against the Routing Table above.
3. If match found: spawn or message the department agent.
4. If no match: handle directly or ask for clarification.
5. When agent responds: summarize the result to the user.
6. Never run exec, mcp_search, or web_search yourself.

## Memory Protocol

1. User asks about past events, people, preferences, todos → call memory_search FIRST.
2. Use short 2-3 word queries. Example: "email setup", "project status".
3. If few results, rephrase and search again with different words.
4. After search, use memory_get to read specific lines from the result files.
5. Write important decisions to memory/YYYY-MM-DD.md after each session.
6. Read MEMORY.md only in main session (direct chat with your human).

## Channel Rules

- You are in one channel per session. Check the "Current Channel" section in your system prompt.
- Do NOT reference conversations from other channels or topics.
- If a message is not for your channel, reply with ONLY: NO_REPLY
- Each Telegram topic is a separate session. Do not mix topics.

## Subagent Communication

- Use sessions_spawn to create new agent sessions for delegation.
- Use message() to send tasks to already-running agents.
- Always include project context: [Project: X | Task: Y] in spawn prompts.
- Wait for agent response before reporting back to user.
- Check sessions_list before spawning to avoid duplicate sessions.

## Session Notes

- Write daily log to memory/YYYY-MM-DD.md.
- Keep entries short: what happened, what was decided, what is pending.
- Do not write secrets to memory files.

## Heartbeats

- Read HEARTBEAT.md when you receive a heartbeat poll.
- If nothing needs attention, reply HEARTBEAT_OK.
- During heartbeats you may: check email, check calendar, update memory files.
```

- [ ] **Step 3: Verify line count and critical section names**

```bash
wc -l ~/.openclaw/workspace/AGENTS.md
grep -c "## Session Startup\|## Red Lines" ~/.openclaw/workspace/AGENTS.md
```

Expected: ~70-80 lines, 2 section name matches

- [ ] **Step 4: Commit**

```bash
cd ~/.openclaw/workspace && git add AGENTS.md && git commit -m "prompt: rewrite AGENTS.md for GLM-5 — structured rules, routing table, memory protocol"
```

---

### Task 5: Clean up MEMORY.md [solo] [software-architect]

**Files:**

- Modify: `~/.openclaw/workspace/MEMORY.md`

**Note:** The plan uses placeholder `[USER_*]` tokens for personal data. At execution time, read the current MEMORY.md first and substitute real values from the existing file.

- [ ] **Step 1: Read current MEMORY.md to understand what to keep**

Read `~/.openclaw/workspace/MEMORY.md`. Keep: User Profile, OpenClaw Setup, QMD Memory System, Lessons Learned (deduplicated). Remove: stale Active Projects table (most are outdated), redundant lessons that are now in AGENTS.md, Workflows section (move to a separate file if needed).

- [ ] **Step 2: Write trimmed MEMORY.md**

Preserve the real personal data values from the existing file. Remove stale project entries, deduplicate lessons with AGENTS.md. Target structure:

```markdown
# MEMORY.md - Long-Term Memory

---

## User Profile

- **Name:** [USER_NAME from existing MEMORY.md]
- **Telegram:** [USER_TELEGRAM from existing]
- **Location:** [USER_LOCATION from existing]
- **Timezone:** [USER_TIMEZONE from existing]
- **Preferences:** [USER_PREFS from existing]

---

## OpenClaw Setup

- **Provider:** `zai/glm-5` | **Channel:** Telegram
- **Workspace:** `~/.openclaw/workspace/`
- **Projects:** `~/dev/operator1/Projects/`
- **Config:** via `openclaw config get/set`

---

## QMD Memory System

- **Backend:** QMD v1.0.0 (3 GGUF models, ~2.2GB)
- **Critical:** Gateway needs explicit PATH in `~/.openclaw/.env`
- **Cold start:** First query may timeout; subsequent queries work fine
- **Verify:** `memory_search` returns `provider: "qmd"` with scores 0.88-0.93

---

## Department Agents

| Agent    | Department  | Role                           |
| -------- | ----------- | ------------------------------ |
| Neo      | Engineering | CTO — code, bugs, deploys, git |
| Morpheus | Marketing   | CMO — content, social, SEO     |
| Trinity  | Finance     | CFO — invoices, budgets, costs |

---

## Key Lessons

1. Never use browser for checking emails — use MCP tools only
2. Provider routing is deterministic, not random
3. Memory isolation — sub-agents have separate memory stores
4. Progress reporting — use `message()`, not `sessions_send()`
5. Telegram images — copy to workspace first before processing
6. Telegram forum topics — use `threadId` for correct routing
7. Skills check — use `openclaw skills list` CLI, not filesystem search

---

## Pending

- [ ] Personal life management approach decision
- [ ] Consider adding second LLM provider as fallback
- [ ] Add WordPress credentials when ready

---

_Last updated: 2026-03-22_
```

- [ ] **Step 3: Verify line count**

```bash
wc -l ~/.openclaw/workspace/MEMORY.md
```

Expected: ~55 lines

- [ ] **Step 4: Commit**

```bash
cd ~/.openclaw/workspace && git add MEMORY.md && git commit -m "prompt: trim MEMORY.md — remove stale projects, deduplicate lessons"
```

---

### Task 6: Add buildChannelSection to system prompt [solo] [backend-architect]

**Files:**

- Modify: `src/agents/system-prompt.ts`
- Modify: `src/agents/system-prompt.test.ts` (add tests to existing file)

- [ ] **Step 1: Write failing test**

Add to the existing `src/agents/system-prompt.test.ts` file:

```typescript
describe("buildChannelSection", () => {
  it("returns empty array when no channelType", () => {
    expect(buildChannelSection({})).toEqual([]);
  });

  it("includes channel type and topic", () => {
    const lines = buildChannelSection({
      channelType: "telegram",
      channelId: "12345",
      topicId: "17",
    });
    const text = lines.join("\n");
    expect(text).toContain("Channel: telegram");
    expect(text).toContain("Topic: 17");
    expect(text).toContain("NO_REPLY");
  });

  it("defaults topic to main when not provided", () => {
    const lines = buildChannelSection({
      channelType: "web",
      channelId: "ui-1",
    });
    expect(lines.join("\n")).toContain("Topic: main");
  });
});
```

Add the import: `import { buildChannelSection } from "./system-prompt.js";`

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- src/agents/system-prompt.test.ts -t "buildChannelSection" -v
```

Expected: FAIL — `buildChannelSection` is not exported

- [ ] **Step 3: Implement buildChannelSection**

Add to `src/agents/system-prompt.ts`, after the existing `buildMemorySection` function. Note: `sanitizeForPromptLiteral` and `SILENT_REPLY_TOKEN` are already imported in this file.

```typescript
export function buildChannelSection(params: {
  channelType?: string;
  channelId?: string;
  topicId?: string;
}): string[] {
  if (!params.channelType) return [];
  return [
    "## Current Channel",
    `Channel: ${sanitizeForPromptLiteral(params.channelType)} | Topic: ${sanitizeForPromptLiteral(params.topicId ?? "main")} | ID: ${sanitizeForPromptLiteral(params.channelId ?? "unknown")}`,
    "Rule: Only respond to messages from this channel and topic.",
    "Rule: Do NOT reference conversations from other channels.",
    `Rule: If a message is not for this channel, reply ${SILENT_REPLY_TOKEN}.`,
    "",
  ];
}
```

- [ ] **Step 4: Wire into buildAgentSystemPrompt**

In `buildAgentSystemPrompt()`, add `channelType`, `channelId`, and `topicId` to the params interface:

```typescript
// Add to params type:
channelType?: string;
channelId?: string;
topicId?: string;
```

Then inject the channel section early in the prompt — after the Safety section and before Skills. Find the line `...skillsSection,` (~line 491) and add before it:

```typescript
...buildChannelSection({
  channelType: params.channelType,
  channelId: params.channelId,
  topicId: params.topicId,
}),
```

- [ ] **Step 5: Move Memory Recall section higher in prompt**

In `buildAgentSystemPrompt()`, the `memorySection` is currently placed after the Skills section (~line 492). Move it to just after the Channel section (before Skills) so GLM-5 gives it more weight:

```typescript
...buildChannelSection({
  channelType: params.channelType,
  channelId: params.channelId,
  topicId: params.topicId,
}),
...memorySection,
...skillsSection,
```

Remove the old `...memorySection,` from its previous position.

**Warning:** Existing tests may assert section ordering. If tests fail after this move, update the assertions to match the new order (channel → memory → skills).

- [ ] **Step 6: Run full system-prompt tests**

```bash
pnpm test -- src/agents/system-prompt -v
```

Expected: All tests PASS (fix ordering assertions if needed)

- [ ] **Step 7: Commit**

```bash
scripts/committer "feat(agent): add channel section to system prompt, move memory recall higher" src/agents/system-prompt.ts src/agents/system-prompt.test.ts
```

---

### Task 7: Session channel-key isolation (B1) [solo] [backend-architect]

**Files:**

- Modify: `src/auto-reply/reply/session.ts`

This is the core fix for cross-channel session bleed. The session system already resolves sessions per-channel via `resolveSessionKey()` and `resolveGroupSessionKey()`. The issue is that Telegram topics may share a session when they shouldn't.

- [ ] **Step 1: Investigate current session key resolution**

```bash
grep -rn "resolveSessionKey\|resolveGroupSessionKey\|MessageThreadId\|topicId\|threadId" src/auto-reply/reply/session.ts src/config/sessions.ts | head -30
```

Understand how the session key is derived. Check if `MessageThreadId` (Telegram topic ID) is already part of the session key. If it's not, that's the root cause of topic cross-talk.

- [ ] **Step 2: Verify Telegram topic session key derivation**

```bash
grep -rn "buildTelegramTopicConversationId\|topic" src/auto-reply/reply/session.ts | head -20
```

Check if `buildTelegramTopicConversationId` is used in session key resolution. If topics are not producing distinct session keys, the fix is to ensure `MessageThreadId` is part of the key.

- [ ] **Step 3: If topics share sessions — fix session key derivation**

If `MessageThreadId` is not part of the session key for Telegram topics, modify the session key resolution to include it. The exact change depends on what Step 1-2 reveals. The pattern should be:

```typescript
// In resolveSessionKey or the Telegram-specific path:
// Ensure topic ID is part of the key when present
const topicSuffix = sessionCtx.MessageThreadId ? `-topic-${sessionCtx.MessageThreadId}` : "";
const sessionKey = `${baseKey}${topicSuffix}`;
```

**If sessions are already isolated by topic** (Steps 1-2 reveal that `MessageThreadId` IS part of the key), skip Steps 3-4 and close this task — the cross-talk issue is elsewhere.

- [ ] **Step 4: Store channelKey in session JSONL header**

When a new session transcript is created, include the channel key in the header entry. Find where the `{ type: "session", version: 3, id: "..." }` header is written and add:

```typescript
channelKey: `${sessionCtx.Surface ?? sessionCtx.Provider ?? "unknown"}:${sessionCtx.AccountId ?? sessionCtx.From ?? "unknown"}:${sessionCtx.MessageThreadId ?? "default"}`,
```

This is informational — for debugging and future enforcement.

- [ ] **Step 5: Run session tests**

```bash
pnpm test -- src/auto-reply/reply/session -v
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(agent): ensure Telegram topics get distinct sessions, store channelKey in session header" src/auto-reply/reply/session.ts
```

---

### Task 8: Pass channel info from session context to system prompt [solo] [backend-architect]

**Files:**

- Modify: `src/agents/system-prompt-params.ts` — Add channel fields to `RuntimeInfoInput`
- Modify: `src/agents/pi-embedded-runner/run/attempt.ts` — Pass channel info to prompt builder
- Possibly modify: `src/auto-reply/reply/agent-runner-execution.ts` — If channel context flows from here

The system prompt is NOT built in `agent-runner-execution.ts`. The actual call chain is:
`agent-runner.ts` → `agent-runner-execution.ts` → `runEmbeddedPiAgent()` → `attempt.ts:buildSystemPromptParams()` → `buildAgentSystemPrompt()`.

Channel info must be threaded through this entire chain.

- [ ] **Step 1: Verify the full call chain and available fields**

```bash
grep -rn "buildAgentSystemPrompt\|buildSystemPromptParams" src/ --include="*.ts" | grep -v test | grep -v ".d.ts"
grep -n "RuntimeInfoInput\|runtimeChannel\|messageProvider" src/agents/pi-embedded-runner/run/attempt.ts | head -20
grep -n "Surface\|Provider\|AccountId\|MessageThreadId" src/auto-reply/templating.ts | head -10
```

Confirm the chain: `TemplateContext.Surface/Provider/MessageThreadId` → through to `buildAgentSystemPrompt(channelType/channelId/topicId)`.

- [ ] **Step 2: Add channel fields to the prompt params pipeline**

In `src/agents/system-prompt-params.ts`, add to the `RuntimeInfoInput` type (or the params of `buildSystemPromptParams`):

```typescript
// Add to the runtime or params type:
channelType?: string;
channelId?: string;
topicId?: string;
```

Ensure these are passed through to the returned `SystemPromptRuntimeParams` and ultimately to `buildAgentSystemPrompt`.

- [ ] **Step 3: Pass channel context in attempt.ts**

In `src/agents/pi-embedded-runner/run/attempt.ts`, at the `buildSystemPromptParams` call (~line 941-958), the `runtimeChannel` variable already exists (resolved from `params.messageProvider` and config). Thread the additional fields:

```typescript
// In the buildSystemPromptParams call, add:
channelType: runtimeChannel,  // Already available
channelId: params.sessionCtx?.AccountId ?? params.sessionCtx?.From,
topicId: params.sessionCtx?.MessageThreadId != null ? String(params.sessionCtx.MessageThreadId) : undefined,
```

Check what `params` contains — `sessionCtx` may need to be threaded from `agent-runner-execution.ts` through `EmbeddedRunParams`.

- [ ] **Step 4: Thread sessionCtx through EmbeddedRunParams if needed**

If `sessionCtx` is not available in `attempt.ts`, it needs to be added to `EmbeddedRunParams` (in `src/agents/pi-embedded-runner/run/types.ts`) and passed from `buildEmbeddedRunExecutionParams` in `agent-runner-execution.ts`.

- [ ] **Step 5: Run existing tests**

```bash
pnpm test -- src/agents/pi-embedded-runner -v
pnpm test -- src/auto-reply/reply/agent-runner -v
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(agent): thread channel info from session context through to system prompt" src/agents/system-prompt-params.ts src/agents/pi-embedded-runner/run/attempt.ts
```

---

### Task 9: Add prefetchMemoryIfNeeded [solo] [backend-architect]

**Files:**

- Modify: `src/auto-reply/reply/agent-runner-memory.ts`
- Modify: `src/auto-reply/reply/agent-runner.ts`
- Create: `src/auto-reply/reply/agent-runner-memory.prefetch.test.ts`

**Important API note:** There is no `searchMemory()` export anywhere in the codebase. Memory search is done via the memory manager: `getMemorySearchManager({ cfg, agentId })` from `src/memory/index.ts`, then `manager.search(query, { maxResults, minScore })`. The `resolveMemorySearchConfig()` from `src/agents/memory-search.ts` checks if memory search is enabled.

- [ ] **Step 1: Write failing tests**

Create `src/auto-reply/reply/agent-runner-memory.prefetch.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  matchesContextTrigger,
  formatPrefetchAsSystemMessage,
  type MemoryPrefetchResult,
} from "./agent-runner-memory.js";

describe("matchesContextTrigger", () => {
  it("matches 'remember' keyword", () => {
    expect(matchesContextTrigger("do you remember the email setup?")).toBe(true);
  });

  it("matches 'last time' keyword", () => {
    expect(matchesContextTrigger("last time we discussed this")).toBe(true);
  });

  it("matches 'yesterday' keyword", () => {
    expect(matchesContextTrigger("what did we do yesterday?")).toBe(true);
  });

  it("does not match generic greetings", () => {
    expect(matchesContextTrigger("hello, how are you?")).toBe(false);
  });

  it("does not match simple commands", () => {
    expect(matchesContextTrigger("check my email")).toBe(false);
  });

  it("matches 'pending' keyword", () => {
    expect(matchesContextTrigger("what tasks are pending?")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(matchesContextTrigger("Do You REMEMBER?")).toBe(true);
  });
});

describe("formatPrefetchAsSystemMessage", () => {
  it("formats results with file path and line", () => {
    const prefetch: MemoryPrefetchResult = {
      results: [
        { path: "memory/2026-03-20.md", line: 12, content: "User asked about email", score: 0.9 },
      ],
      query: "email setup",
    };
    const msg = formatPrefetchAsSystemMessage(prefetch);
    expect(msg).toContain("memory/2026-03-20.md#L12");
    expect(msg).toContain("User asked about email");
  });

  it("formats results without line number", () => {
    const prefetch: MemoryPrefetchResult = {
      results: [{ path: "memory/2026-03-20.md", content: "Some content", score: 0.8 }],
      query: "test",
    };
    const msg = formatPrefetchAsSystemMessage(prefetch);
    expect(msg).toContain("memory/2026-03-20.md:");
    expect(msg).not.toContain("#L");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- src/auto-reply/reply/agent-runner-memory.prefetch.test.ts -v
```

Expected: FAIL — exports not found

- [ ] **Step 3: Implement matchesContextTrigger, prefetchMemoryIfNeeded, and formatPrefetchAsSystemMessage**

Add static imports at the top of `src/auto-reply/reply/agent-runner-memory.ts`:

```typescript
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { getMemorySearchManager } from "../../memory/index.js";
```

Then add the implementation:

```typescript
const CONTEXT_TRIGGERS =
  /\b(remember|last time|before|earlier|yesterday|previous|we discussed|you said|I told you|what was|did we|pending|todo|remind me|what happened)\b/i;

/** Exported for testing. */
export function matchesContextTrigger(message: string): boolean {
  return CONTEXT_TRIGGERS.test(message);
}

export type MemoryPrefetchResult = {
  results: Array<{ path: string; line?: number; content: string; score: number }>;
  query: string;
};

/**
 * Pre-fetch memory search results when the user message references past context.
 * Returns null if no trigger matched, memory is disabled/unavailable, or no results found.
 */
export async function prefetchMemoryIfNeeded(params: {
  message: string;
  agentId: string;
  config: OpenClawConfig;
}): Promise<MemoryPrefetchResult | null> {
  if (!matchesContextTrigger(params.message)) return null;

  // Check if memory search is enabled for this agent
  const memConfig = resolveMemorySearchConfig(params.config, params.agentId);
  if (!memConfig) return null;

  try {
    const manager = await getMemorySearchManager({ cfg: params.config, agentId: params.agentId });
    if (!manager) return null;

    const query = params.message.slice(0, 100);
    const results = await Promise.race([
      manager.search(query, { maxResults: 3 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("memory prefetch timeout")), 5000),
      ),
    ]);
    if (!results || results.length === 0) return null;
    return {
      results: results.map((r: any) => ({
        path: r.path ?? r.source ?? "unknown",
        line: r.line ?? r.lineNumber,
        content:
          typeof r.content === "string"
            ? r.content.slice(0, 200)
            : String(r.text ?? "").slice(0, 200),
        score: r.score ?? 0,
      })),
      query,
    };
  } catch {
    return null; // Graceful skip — don't block the reply on cold QMD or errors
  }
}

/**
 * Format prefetch results as a system message to inject into the conversation.
 */
export function formatPrefetchAsSystemMessage(prefetch: MemoryPrefetchResult): string {
  const lines = ["[Memory context — auto-retrieved, may be relevant:]"];
  for (const r of prefetch.results) {
    const loc = r.line ? `${r.path}#L${r.line}` : r.path;
    lines.push(`- From ${loc}: "${r.content.trim()}"`);
  }
  return lines.join("\n");
}
```

**Important:** Verify the actual exports and function signatures of `getMemorySearchManager` by reading `src/memory/index.ts` before implementing. The manager's `search()` method return shape may differ from the mapping above — adjust the `.map()` accordingly.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- src/auto-reply/reply/agent-runner-memory.prefetch.test.ts -v
```

Expected: PASS

- [ ] **Step 5: Wire prefetch into agent-runner.ts using enqueueSystemEvent**

In `src/auto-reply/reply/agent-runner.ts`, after the `runMemoryFlushIfNeeded` call (~line 227-241) and before `runAgentTurnWithFallback`, add:

```typescript
import { prefetchMemoryIfNeeded, formatPrefetchAsSystemMessage } from "./agent-runner-memory.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";

// After runMemoryFlushIfNeeded, before runAgentTurnWithFallback:
const agentId = sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined;
if (agentId && !isHeartbeat && sessionKey) {
  const prefetch = await prefetchMemoryIfNeeded({
    message: commandBody,
    agentId,
    config: cfg,
  });
  if (prefetch) {
    // Inject as a system event — drained before next agent turn as system context
    enqueueSystemEvent(formatPrefetchAsSystemMessage(prefetch), { sessionKey });
  }
}
```

**Note:** `enqueueSystemEvent(text, { sessionKey })` is the correct API. It takes `(text: string, options: { sessionKey: string; contextKey?: string | null })`. Events are drained before the next agent turn via `drainSystemEvents(sessionKey)` and presented as system context — NOT as part of the user message. This avoids the semantic issue of mixing system context into user messages.

- [ ] **Step 6: Run agent-runner tests**

```bash
pnpm test -- src/auto-reply/reply/agent-runner -v
```

Expected: All PASS

- [ ] **Step 7: Commit**

```bash
scripts/committer "feat(agent): add memory pre-fetch for context-referencing messages" src/auto-reply/reply/agent-runner-memory.ts src/auto-reply/reply/agent-runner.ts src/auto-reply/reply/agent-runner-memory.prefetch.test.ts
```

---

### Task 10: Add delegation nudge post-processing [solo] [backend-architect]

**Files:**

- Modify: `src/auto-reply/reply/agent-runner.ts`

**Important API note:** The agent turn result type is `EmbeddedRunAttemptResult` (from `src/agents/pi-embedded-runner/run/types.ts`). Tool call metadata is in the `toolMetas` field (NOT `toolCalls`), typed as `Array<{ toolName: string; meta?: string }>` (NOT `name`).

- [ ] **Step 1: Verify the run outcome type**

```bash
grep -n "toolMetas\|EmbeddedRunAttemptResult" src/agents/pi-embedded-runner/run/types.ts | head -10
```

Confirm the field name and type shape.

- [ ] **Step 2: Implement checkDelegationMissed**

Add near the top of `agent-runner.ts` (before the `runReplyAgent` export):

```typescript
function checkDelegationMissed(
  toolMetas: Array<{ toolName: string; meta?: string }>,
): string | null {
  const directWorkTools = ["exec", "mcp_search", "web_search", "web_fetch"];
  const delegationTools = ["sessions_spawn", "message"];
  const directWork = toolMetas.filter((t) => directWorkTools.includes(t.toolName));
  const delegated = toolMetas.filter((t) => delegationTools.includes(t.toolName));

  if (directWork.length > 3 && delegated.length === 0) {
    return `SYSTEM NOTE: You made ${directWork.length} direct tool calls this turn without delegating. Review your routing rules in AGENTS.md. Should this task go to Neo, Morpheus, or Trinity?`;
  }
  return null;
}
```

- [ ] **Step 3: Wire into post-turn processing using enqueueSystemEvent**

After the agent turn completes (after `runAgentTurnWithFallback` returns `runOutcome`) and before building reply payloads:

```typescript
import { enqueueSystemEvent } from "../../infra/system-events.js";

// After runOutcome is available:
const delegationNudge = checkDelegationMissed(runOutcome.toolMetas ?? []);
if (delegationNudge && sessionKey) {
  // Enqueue as system event — agent sees it on the next turn, not visible to user
  enqueueSystemEvent(delegationNudge, { sessionKey });
}
```

**API:** `enqueueSystemEvent(text: string, options: { sessionKey: string })` — events are in-memory, ephemeral, session-scoped, capped at 20, and deduped. They are drained before the next agent turn via `drainSystemEvents(sessionKey)`.

- [ ] **Step 4: Run tests**

```bash
pnpm test -- src/auto-reply/reply/agent-runner -v
```

Expected: All PASS

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(agent): add delegation nudge when agent uses too many direct tools" src/auto-reply/reply/agent-runner.ts
```

---

### Task 11: Update compaction prompt for channel awareness [solo] [software-architect]

**Files:**

- Config change via CLI
- Modify: `src/auto-reply/reply/agent-runner.ts` — post-compaction re-injection

- [ ] **Step 1: Read current compaction config**

```bash
openclaw config get agents.defaults.compaction.memoryFlush.prompt
```

- [ ] **Step 2: Update compaction prompt**

```bash
openclaw config set agents.defaults.compaction.memoryFlush.prompt "Extract and save important information to memory:

1. User preferences and explicit requests to remember
2. Key decisions and their rationale
3. Project milestones and status changes
4. Important contacts and their context
5. Channel and topic context for each conversation thread

IMPORTANT: Note which channel (telegram/web/discord) and topic each conversation belongs to. Do not merge conversations from different channels.

Write to memory/YYYY-MM-DD.md and reply with NO_REPLY if nothing to store."
```

- [ ] **Step 3: Verify**

```bash
openclaw config get agents.defaults.compaction.memoryFlush.prompt
```

Expected: Contains "channel and topic context" and "Do not merge conversations"

- [ ] **Step 4: Add post-compaction channel re-injection in agent-runner.ts**

In `src/auto-reply/reply/agent-runner.ts`, change the `commandBody` destructuring from `const` to `let`:

```typescript
// Change: const { commandBody, ... } = params;
// To:     let { commandBody } = params;  (destructure separately)
//         const { followupRun, ... } = params;  (rest stays const)
```

Then after the `runMemoryFlushIfNeeded` call (~line 227-241), add:

```typescript
// Check if compaction happened (session was reset to a new ID)
const compactionOccurred = activeSessionEntry?.sessionId !== sessionEntry?.sessionId;
if (compactionOccurred && sessionCtx.Surface) {
  const channelReminder = [
    "[Post-compaction channel reminder]",
    `Channel: ${sessionCtx.Surface ?? sessionCtx.Provider ?? "unknown"}`,
    `Topic: ${sessionCtx.MessageThreadId ?? "main"}`,
    "Continue responding only to this channel.",
  ].join("\n");
  commandBody = `${channelReminder}\n\n${commandBody}`;
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm test -- src/auto-reply/reply/agent-runner -v
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
scripts/committer "feat(agent): add channel-aware compaction prompt and post-compaction re-injection" src/auto-reply/reply/agent-runner.ts
```

---

### Task 12: Restrict Operator1 tool policy [batch] [software-architect]

**Files:**

- Config change via CLI

**Note:** There is no `openclaw config patch` command. Use individual `openclaw config set` calls.

- [ ] **Step 1: Read current tool config**

```bash
openclaw config get agents.list
```

Verify the main agent's current tool config (if any).

- [ ] **Step 2: Apply tool restriction via individual config set calls**

```bash
openclaw config set agents.list.0.tools.profile messaging
openclaw config set agents.list.0.tools.alsoAllow '["gateway", "memory_search", "memory_get", "cron", "sessions_spawn", "message", "agents_list", "sessions_list", "sessions_history", "sessions_send", "subagents", "session_status", "read", "write", "edit", "image"]'
```

**Known spec deviation (B6):** The spec calls for `elevated.allowFrom` to hard-gate `exec`/`mcp_search` behind explicit user approval. This task intentionally starts softer — no `elevated` block, just `profile: "messaging"` with an explicit `alsoAllow` list that excludes `exec`/`mcp_search`. The prompt changes and delegation nudge should push the agent away from those tools. If the agent still overuses them after a 7-day observation period, add the `elevated` block as a follow-up.

- [ ] **Step 3: Verify**

```bash
openclaw config get agents.list.0.tools
```

Expected: Shows `profile: "messaging"` with the `alsoAllow` list.

- [ ] **Step 4: Restart gateway to apply**

Restart via the OpenClaw Mac app or:

```bash
scripts/restart-mac.sh
```

**Do NOT use `pkill -f openclaw-gateway`** — the gateway runs as the menubar app, not a LaunchAgent. Killing it without the app will not auto-restart.

---

### Task 13: Build and run full test suite [batch] [code-reviewer]

**Files:**

- No file changes — verification only

- [ ] **Step 1: Type check**

```bash
pnpm tsgo
```

Expected: No errors

- [ ] **Step 2: Lint and format**

```bash
pnpm check
```

Expected: No errors

- [ ] **Step 3: Run test suite**

```bash
pnpm test
```

Expected: All tests pass

- [ ] **Step 4: Build**

```bash
pnpm build
```

Expected: No errors, no `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings

---

## Library References

> No external libraries involved — all changes are internal TypeScript and workspace file modifications.

## Codebase API Reference (verified 2026-03-22)

- **Memory search:** `getMemorySearchManager({ cfg, agentId })` from `src/memory/index.ts` → `manager.search(query, { maxResults, minScore })`
- **Memory config check:** `resolveMemorySearchConfig(cfg, agentId)` from `src/agents/memory-search.ts`
- **System event injection:** `enqueueSystemEvent(text, { sessionKey })` from `src/infra/system-events.ts` — in-memory, ephemeral, capped at 20, drained before next agent turn
- **Agent turn result:** `EmbeddedRunAttemptResult.toolMetas: Array<{ toolName: string; meta?: string }>` from `src/agents/pi-embedded-runner/run/types.ts`
- **System prompt chain:** `agent-runner.ts` → `agent-runner-execution.ts` → `runEmbeddedPiAgent()` → `attempt.ts:buildSystemPromptParams()` → `buildAgentSystemPrompt()`
- **SILENT_REPLY_TOKEN:** Value is `"NO_REPLY"` (from `src/auto-reply/tokens.ts`)
- **Post-compaction sections:** Looks for `"Session Startup"` and `"Red Lines"` (legacy fallback: `"Every Session"`, `"Safety"`) in AGENTS.md
- **Config CLI:** `openclaw config get/set/unset/file/validate` — no `patch` command
- **Gateway restart:** Via Mac app or `scripts/restart-mac.sh` — NOT `pkill` (no LaunchAgent auto-restart)
