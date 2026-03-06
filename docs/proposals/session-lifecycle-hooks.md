# Proposal: Session Lifecycle Hooks (`session:pause` / `session:resume`)

**Author:** Eddie Abrams, Tabitha  
**Date:** 2026-03-05  
**Status:** Draft  
**Origin:** Hatchery discussion on agent commitment tracking → generalized to session state management

---

## Problem

When an agent session ends (timeout, context limit, explicit close, restart), all in-flight context is lost. Agents attempt to compensate with manual persistence patterns (MEMORY.md, daily notes, Vestige ingestion), but these are ad-hoc, inconsistent, and depend on the agent remembering to save before context dies.

This creates concrete failure modes:

- **Dropped commitments:** Agent promises to do X, session ends, promise evaporates
- **Lost task context:** Agent was mid-task, resumes cold with no knowledge of prior state
- **Redundant work:** Agent re-discovers things it already knew last session
- **Plugin state loss:** Plugins with session-scoped state (taint watermarks, task queues, conversation classifiers) have no lifecycle hook to persist/restore

## Analogy

Operating systems solved this decades ago. When a laptop sleeps, each process receives a notification and gets a chance to save state. On wake, each process restores its own state. The OS orchestrates the lifecycle; processes own their domain-specific persistence.

OpenClaw should work the same way.

## Proposal

### New Lifecycle Events

Add two new hook points to the OpenClaw plugin hook system:

#### `session:pause`

Fired when a session is about to become inactive. Triggers:

- Session timeout (idle expiry)
- Context window limit reached (before compaction/reset)
- Explicit session close
- Gateway restart / SIGUSR1
- Agent-initiated pause (future)

**Payload:**

```typescript
interface SessionPauseEvent {
  sessionKey: string;
  reason: "timeout" | "context_limit" | "explicit_close" | "restart" | "agent_initiated";
  sessionDurationMs: number;
  messageCount: number;
  // Summary of recent context — gateway-provided, not plugin-specific
  recentContext?: {
    lastUserMessage?: string;
    lastAgentMessage?: string;
    activeToolCalls?: string[];
  };
}
```

**Plugin response:**

```typescript
interface SessionPauseResult {
  // Opaque state blob the plugin wants persisted — core stores it,
  // plugin interprets it on resume
  state?: Record<string, unknown>;
  // Optional human-readable summary for workspace file injection
  summary?: string;
}
```

#### `session:resume`

Fired when a session starts or resumes. Triggers:

- New session creation
- Session resumption after pause
- Gateway restart recovery

**Payload:**

```typescript
interface SessionResumeEvent {
  sessionKey: string;
  resumeReason: "new" | "resume_after_pause" | "restart_recovery";
  // State blobs returned by each plugin's last session:pause handler
  pluginStates: Record<string, Record<string, unknown>>;
  pauseDurationMs?: number; // Time since last pause, if resuming
}
```

**Plugin response:**

```typescript
interface SessionResumeResult {
  // Context to inject into the session before the first LLM call
  contextInjection?: {
    content: string;
    priority: "high" | "normal" | "low"; // Ordering in context window
    estimatedTokens?: number;
  };
}
```

### Core Responsibilities

The gateway/core owns:

1. **Detecting lifecycle transitions** — knowing when a session is pausing/resuming
2. **Broadcasting events** — calling registered plugin hooks in order
3. **Persisting plugin state** — storing each plugin's opaque state blob between sessions (lightweight key-value, keyed by session + plugin)
4. **Injecting resume context** — collecting plugin responses and injecting them into the session context window at appropriate priority

### Plugin Responsibilities

Each plugin owns:

1. **Deciding what to save** — what matters for _its_ domain
2. **Deciding what to restore** — what context to inject on resume
3. **Graceful degradation** — if no prior state exists (new session, state expired), the plugin handles that cleanly

### Storage

Plugin state between sessions needs a lightweight persistence layer. Options (in order of preference):

1. **Session record extension** — add a `pluginState` field to the existing session storage. Natural home, already persisted, already keyed by session.
2. **Workspace file** — write `.session-state.json` to workspace. Simple, human-inspectable, but doesn't scale to multiple concurrent sessions.
3. **Dedicated store** — new persistence layer. Overkill for v1.

Recommendation: Option 1 for structured state, with an optional workspace file output for human-readable summaries.

## Example: How Existing Plugins Would Use This

### Vestige (Cognitive Memory)

**On `session:pause`:**

- Scan recent conversation for significant events not yet ingested
- Ingest any final learnings/decisions
- Return state: `{ lastIngestedMessageIndex: N }`

**On `session:resume`:**

- Search for memories relevant to the session context (user, recent topics)
- Search for open commitments (`node_type: "commitment", status: "open"`)
- Return context injection: relevant memories + open commitments as system context

### Provenance (Security/Taint)

**On `session:pause`:**

- Return state: `{ taintLevel, watermarks, approvedTools }`

**On `session:resume`:**

- Restore taint watermarks from prior session (or start clean if new)
- Return context injection: current trust state summary

### Beads (Task Tracking)

**On `session:pause`:**

- Snapshot current task state: what's claimed, what's in-progress, what's blocked
- Return state: `{ claimedIssues, inProgressIssue, lastReadyOutput }`

**On `session:resume`:**

- Return context injection: "You were working on X. Unblocked tasks: Y, Z."

### Future: Commitment Tracker

**On `session:pause`:**

- LLM sweep of outbound messages for unfulfilled commitments
- Persist detected commitments (to Vestige or its own store)
- Return state: `{ openCommitments: [...] }`

**On `session:resume`:**

- Surface open commitments as high-priority context injection
- "You promised Anisha you'd redo the screenshots. You told Eddie you'd file the bug."

## Design Principles

1. **Plugins are opinionated, core is not.** Core doesn't know what "session state" means for any given plugin. It just provides the lifecycle hooks and a persistence slot.

2. **Graceful degradation.** No plugin installed? Session start/stop works exactly as it does today. One plugin installed? Only that plugin's state is managed. The feature composes additively.

3. **Context budget awareness.** Resume injections should declare estimated token counts. Core can enforce a total budget and prioritize by declared priority level, preventing plugins from collectively blowing the context window.

4. **Human-inspectable.** Plugin state should have an optional human-readable summary that can be written to workspace files. Agents and humans should be able to see what was saved and why.

5. **No mandatory persistence dependency.** Plugins should work even if core's state storage fails. The hooks are best-effort enrichment, not hard dependencies.

## Relationship to Existing Patterns

This formalizes what agents already do manually:

- **MEMORY.md** → manual `session:pause` (agent writes what it learned)
- **HEARTBEAT.md** → manual `session:resume` (agent reads what to check)
- **Daily notes** → manual state persistence (agent journals context)
- **Workspace files** → manual context injection (loaded at session start)

The proposal doesn't replace these patterns — it augments them with automated, plugin-driven lifecycle management.

## Open Questions

1. **Hook ordering:** Should plugins declare dependencies for pause/resume ordering? (e.g., commitment tracker runs after Vestige so it can ingest before Vestige does its final sweep)
2. **State TTL:** How long should plugin state be retained? Per-session? Time-bounded? Plugin-declared?
3. **Compaction events:** Should context window compaction (mid-session summarization) fire a lighter-weight variant of `session:pause`? The agent doesn't stop, but context is being lost.
4. **Multi-session:** How does this interact with isolated/sub-agent sessions? Should spawned sessions inherit parent plugin state?

## Implementation Path

1. **v0 (now):** Agents use SOUL.md discipline + manual Vestige calls. This is what we have today.
2. **v1:** Core adds `session:pause` / `session:resume` hooks with state persistence on session records. Vestige and Provenance implement handlers.
3. **v2:** Add context budget management, hook ordering, compaction events. Beads and commitment tracker implement handlers.
4. **v3:** Cross-session state sharing, sub-agent state inheritance.

---

_This proposal originated from a multi-agent discussion (Telemachus, Tank, Tabitha) about dropped commitments, generalized to the broader session lifecycle problem. The OS sleep/wake analogy and plugin-agnostic design are the key insights._
