# Operator1 Agent Improvements — Design Spec

**Date:** 2026-03-22
**Workflow ID:** CCDCE834-B0C6-457D-A5D2-E5F62286E004
**Status:** Draft

---

## Problem Statement

The Operator1 main agent (COO) running on GLM-5 (Z.ai) has multiple interrelated issues:

1. **Cross-channel session bleed** — Responses leak between web UI and Telegram; wrong Telegram topics receive replies
2. **Memory unreliability** — Only 9 memory_search calls across 15 sessions; agent forgets context
3. **No delegation** — Agent runs 108 exec calls, 460 mcp_search calls instead of routing to Neo/Morpheus/Trinity
4. **Compaction confusion** — After context compaction, agent loses channel/topic orientation
5. **Prompt inefficiency** — Current prompts are written for frontier models; GLM-5 needs rigid, explicit instructions

**Root cause:** Prompts assume frontier-model reasoning. GLM-5 needs structured decision trees, explicit rules, and backend enforcement to compensate.

---

## Approach

**Prompt hardening + lightweight backend guardrails.** Two workstreams:

- **Workstream A (Prompts):** Rewrite all workspace files for GLM-5 — short imperative sentences, numbered rules, routing tables, reduced token count
- **Workstream B (Backend):** Add code-level guards for session isolation, forced memory search, compaction fixes, and delegation nudges

---

## Workstream A: Prompt Rewrites

### A1. AGENTS.md Rewrite

**Current:** ~290 lines, prose-heavy, generic boilerplate (group chat etiquette, heartbeat mechanics, reaction guidelines, platform formatting).

**Target:** ~120 lines max. Rules-based. Every section earns its token cost.

**Structure:**

```
# AGENTS.md

## Rules (always follow)
1. Read SOUL.md first. You are a router, not a worker.
2. Check memory_search before answering questions about the past.
3. Only respond to messages for YOUR current channel and topic.
4. Delegate tasks to department agents. Do not use exec or mcp_search yourself.
5. Report results concisely. 2-3 sentences unless detail is requested.

## Routing Table
| Signal | Route To | Action |
|--------|----------|--------|
| Code, engineering, bugs, deploy | Neo (CTO) | sessions_spawn or message |
| Marketing, content, social, SEO | Morpheus (CMO) | sessions_spawn or message |
| Finance, invoices, budget, costs | Trinity (CFO) | sessions_spawn or message |
| Simple question, greeting, status | Handle directly | Reply yourself |
| Ambiguous | Ask user | "Should I route this to [agent]?" |

## Memory Protocol
1. User asks about past events, people, preferences, todos → call memory_search FIRST
2. Use 2-3 word queries. If few results, rephrase and search again.
3. After search, use memory_get to read specific lines.
4. Write important decisions to memory/YYYY-MM-DD.md after each session.

## Channel Rules
- You are in one channel per session.
- Do NOT reference conversations from other channels.
- If a message is not for your channel, reply SILENT_REPLY_TOKEN.

## Session Notes
- Write daily log to memory/YYYY-MM-DD.md.
- Keep entries short: what happened, what was decided, what's pending.

## Subagent Communication
- Use sessions_spawn to create new agent sessions.
- Use message() to send tasks to running agents.
- Always include: [Project: X | Task: Y] in spawn prompts.
- Wait for agent response before reporting to user.
```

**Removed content (moved elsewhere):**

- Group chat etiquette → inject only for group chat sessions via extraSystemPrompt
- Heartbeat mechanics → stays in HEARTBEAT.md (already there)
- Reaction guidelines → inject per-channel
- Platform formatting → inject per-channel
- Project Context System → simplified into Routing Table

### A2. SOUL.md Rewrite

**Current:** Vague ("operating backbone", "ensure the right people do").

**Target:**

```
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
- Search the web (mcp_search) — delegate to the right agent
- Write code — that is Neo's job
- Create marketing content — that is Morpheus's job

## Communication style:
- Lead with the answer or routing decision
- 2-3 sentences max unless user asks for detail
- Use tables for multi-item status reports
- Never hedge — decide and route
```

### A3. TOOLS.md Rewrite

**Current:** Lists generic tools (read, write, exec). Meaningless.

**Target:** Document the actual RPC methods and delegation tools available.

```
# TOOLS.md — Operator1

## Your Primary Tools
- gateway(action, ...) — Call RPC methods on the gateway
- memory_search(query) — Search your memory for past context
- memory_get(path, from, lines) — Read specific memory file lines
- sessions_spawn — Create a new agent session (for delegation)
- message — Send a message to a running agent session
- read/write/edit — Manage workspace files only
- cron — Create/manage scheduled tasks

## Gateway RPC Methods You Should Use
- tasks.list / tasks.create / tasks.update — Task management
- agents.list — See available agents
- sessions.list — See active sessions
- memory.status — Check memory health
- config.get — Read configuration

## Tools You Should NOT Use Directly
- exec — Delegate to the appropriate agent instead
- mcp_search — Delegate research to the appropriate agent
- web_search / web_fetch — Delegate to the appropriate agent
```

### A4. MEMORY.md Cleanup

**Current:** 97 lines with stale project table, outdated lessons learned.

**Target:** ~50 lines. Remove stale project entries, keep only active/relevant context. Remove numbered lessons that duplicate AGENTS.md rules.

### A5. IDENTITY.md — Delete

Content is redundant with SOUL.md. Merge any unique fields (department, role) into SOUL.md header.

---

## Workstream B: Backend Guardrails

### B1. Session Channel-Key Isolation

**File:** `src/auto-reply/reply/agent-runner-helpers.ts`

**Change:** When resolving a session for a reply:

```typescript
// Derive channel key from the incoming message
const channelKey = `${msg.channelType}:${msg.channelId}:${msg.topicId ?? "default"}`;

// Check if the active session matches this channel key
const activeSession = getActiveSession(agentId);
if (activeSession && activeSession.channelKey !== channelKey) {
  // Force a new session — do not reuse cross-channel
  return createNewSession(agentId, { channelKey });
}
```

**Session header:** Store `channelKey` in the session JSONL header entry:

```json
{ "type": "session", "version": 3, "id": "...", "channelKey": "telegram:12345:topic-17" }
```

**Migration:** Existing sessions without `channelKey` continue working. New sessions get the key. No breaking change.

### B2. Channel Context Injection in System Prompt

**File:** `src/agents/system-prompt.ts`

**Change:** Add a `## Current Channel` section to `buildAgentSystemPrompt()`:

```typescript
function buildChannelSection(params: {
  channelType?: string;
  channelId?: string;
  topicId?: string;
}) {
  if (!params.channelType) return [];
  const lines = [
    "## Current Channel",
    `Channel: ${params.channelType} | Topic: ${params.topicId ?? "main"} | ID: ${params.channelId}`,
    "Rule: Only respond to messages from this channel and topic.",
    "Rule: Do NOT reference conversations from other channels.",
    "Rule: If a message is not for this channel, reply SILENT_REPLY_TOKEN.",
    "",
  ];
  return lines;
}
```

Place this section early in the prompt (after Identity, before Tools) for maximum weight with GLM-5.

### B3. Pre-fetch Memory Search

**File:** `src/auto-reply/reply/agent-runner-memory.ts` (existing file — already contains `runMemoryFlushIfNeeded()`)

**Call site:** `src/auto-reply/reply/agent-runner.ts` — call `prefetchMemoryIfNeeded()` after the memory flush step and before the main agent turn in `runReplyAgent()`.

**Change:** Add a new exported function to `agent-runner-memory.ts`. Before the main agent turn, check if the user message likely references past context:

```typescript
const CONTEXT_TRIGGERS =
  /\b(remember|last time|before|earlier|yesterday|previous|we discussed|you said|I told you|what was|did we|pending|todo)\b/i;

async function prefetchMemoryIfNeeded(
  message: string,
  agentId: string,
): Promise<MemoryPrefetch | null> {
  if (!CONTEXT_TRIGGERS.test(message)) return null;

  try {
    const results = await memorySearch({
      query: message.slice(0, 100),
      agentId,
      maxResults: 3,
      timeoutMs: 5000, // Don't block on cold QMD
    });
    return results.length > 0 ? { results, query: message.slice(0, 100) } : null;
  } catch {
    return null; // Graceful skip
  }
}
```

Inject the results as a system message before the user message:

```
[Memory context — auto-retrieved, may be relevant:]
- From memory/2026-03-20.md#L12: "User asked about email integration..."
- From memory/2026-03-19.md#L5: "Decided to use Lark mail..."
```

### B4. Compaction Channel Awareness

**File:** Config change via `openclaw config set`

**Change:** Update the compaction memoryFlush prompt to include channel preservation:

```
Extract and save important information to memory:

1. User preferences and explicit requests to remember
2. Key decisions and their rationale
3. Project milestones and status changes
4. Important contacts and their context
5. Channel and topic context for each conversation thread

IMPORTANT: Note which channel (telegram/web/discord) and topic each
conversation belongs to. Do not merge conversations from different channels.

Write to memory/YYYY-MM-DD.md and reply with NO_REPLY if nothing to store.
```

**Post-compaction re-injection:** In `src/auto-reply/reply/agent-runner.ts`, after `runMemoryFlushIfNeeded()` completes (which handles compaction), check if compaction occurred. If so, prepend a system message to the next turn with the `## Current Channel` block (reusing `buildChannelSection()` from B2). This ensures the agent re-orients to the correct channel after context was compacted.

### B5. Delegation Nudge

**File:** `src/auto-reply/reply/agent-runner.ts`

**Change:** After the agent turn completes, count direct tool usage:

```typescript
function checkDelegationMissed(toolCalls: ToolCall[]): string | null {
  const directWork = toolCalls.filter((t) => ["exec", "mcp_search", "web_search"].includes(t.name));
  const delegated = toolCalls.filter((t) => ["sessions_spawn", "message"].includes(t.name));

  if (directWork.length > 3 && delegated.length === 0) {
    return `SYSTEM NOTE: You made ${directWork.length} direct tool calls this turn without delegating. Review your routing rules in AGENTS.md. Should this task go to Neo, Morpheus, or Trinity?`;
  }
  return null;
}
```

Append the nudge as a system message in the session transcript (not visible to user, but affects next turn).

### B6. Tool Policy Restriction

**Change via config:**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "profile": "messaging",
          "alsoAllow": [
            "gateway",
            "memory_search",
            "memory_get",
            "cron",
            "sessions_spawn",
            "message",
            "read",
            "write",
            "edit"
          ],
          "elevated": {
            "allowFrom": {
              "exec": ["user"],
              "mcp_search": ["user"]
            }
          }
        }
      }
    ]
  }
}
```

This makes `exec` and `mcp_search` require explicit user request, pushing the agent toward delegation by default.

**Note:** The `elevated.allowFrom` config key is an existing feature in the `AgentToolsSchema` (see `src/config/zod-schema.agent-runtime.ts`). No new config parser work is needed — this is a pure config change via `openclaw config set`.

---

## Implementation Order

1. **Prompt rewrites** (A1-A5) — Can be done immediately, no code changes, instant impact
2. **Channel injection** (B2) — System prompt change, low risk
3. **Session isolation** (B1) — Core fix for cross-channel bleed
4. **Tool policy** (B6) — Config change, instant delegation improvement
5. **Memory pre-fetch** (B3) — Improves memory reliability
6. **Compaction fix** (B4) — Config change + minor code
7. **Delegation nudge** (B5) — Soft enforcement, lowest priority

---

## Risks & Mitigations

| Risk                                       | Mitigation                                                   |
| ------------------------------------------ | ------------------------------------------------------------ |
| Session isolation breaks existing sessions | Graceful migration: no channelKey = legacy mode              |
| Tool restriction over-constrains           | Start with elevated (ask user), not deny. Can tighten later. |
| Memory pre-fetch adds latency              | 5s timeout, skip on failure, only trigger on keyword match   |
| GLM-5 ignores new prompt rules             | Backend guards (B1-B6) enforce the critical ones regardless  |
| Delegation nudge ignored                   | It's soft; tool restriction (B6) is the hard guard           |

---

## Out of Scope

- Memory backend changes (QMD/LanceDB infrastructure is solid)
- Subagent system changes (spawning works, just underused)
- Model change (staying on GLM-5)
- UI changes
- Neo/Morpheus/Trinity prompt changes (separate effort)
- Changes to HEARTBEAT.md (already appropriate)

---

## Success Criteria

1. Operator1 delegates >50% of engineering/marketing/finance tasks to subagents
2. No cross-channel response bleed in a 7-day observation period
3. memory_search called in >80% of sessions referencing past context
4. Telegram topic routing is correct >95% of the time
5. Post-compaction sessions maintain channel awareness
