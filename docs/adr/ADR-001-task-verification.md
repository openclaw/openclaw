# ADR-001: Task Verification & Accountability System

**Date:** 2026-02-14  
**Status:** Implemented  
**Authors:** @higginsvott, @justinhenriksen

## Context

AI agents can claim to have performed actions without actually doing them. There's no independent verification mechanism — self-reporting is honor-system.

**Problem Statement:** How do we verify that an agent actually did what it claims to have done, before that claim reaches the user?

**Extended Goal:** Enable accountability by tying tasks to external systems (e.g., GitHub issues) with mechanical enforcement.

## Decision

Implement a two-layer verification system using plugin hooks:

1. **`before_agent_start` hook** — Inject mandatory instructions/protocols into system prompt
2. **`before_response` hook** — Verify completion claims against audit log before delivery

### Why Two Layers?

| Layer        | Purpose                             | Mechanism                 |
| ------------ | ----------------------------------- | ------------------------- |
| Instructions | Guide agent toward correct behavior | System prompt injection   |
| Verification | Enforce compliance mechanically     | Audit log cross-reference |

Instructions alone can be ignored. Verification alone doesn't guide behavior. Together: belt and suspenders.

## Alternatives Considered

### 1. Instruction Injection Only (`before_agent_start`)

Inject requirements into system prompt.

```typescript
api.on("before_agent_start", () => ({
  prependContext: "MANDATORY: Create GitHub issue before starting work...",
}));
```

✅ Simple, uses existing hook  
❌ No enforcement — agent can ignore  
**Verdict:** Necessary but not sufficient

### 2. Mandatory Skills Config

Add config option to always load certain skills.

```json
{ "skills": { "mandatory": ["github-issue-gate"] } }
```

✅ Leverages skill system  
❌ Requires core changes, still just guidance  
**Verdict:** Good enhancement, doesn't solve verification

### 3. Response Verification Only (`before_response`)

Check audit log before allowing completion claims.

✅ Hard enforcement  
❌ Doesn't guide agent toward correct behavior  
**Verdict:** Necessary but needs guidance layer

### 4. Message Wrapping (`message_received`)

Transform incoming messages to include protocol.

```typescript
api.on("message_received", (event) => ({
  content: `[PROTOCOL: Create issue first]\n\n${event.content}`,
}));
```

✅ Every message gets protocol  
❌ Pollutes history, feels hacky  
**Verdict:** Fallback if 1+3 fails

### 5. Tool Gating (`before_tool_call`)

Block tools unless prerequisites met.

```typescript
api.on("before_tool_call", (event, ctx) => {
  if (!hasGitHubIssue(ctx)) return { block: true };
});
```

✅ Prevents work without accountability  
❌ Requires session state, may be too restrictive  
**Verdict:** Consider if 1+3 too loose

## Implementation

### New Plugin Hooks

- **`before_response`** — Fires before assistant response delivery
  - Event: `{ text, toolCalls, mediaUrls }`
  - Result: `{ text?, block?, blockReason?, prependWarning? }`

### Plugins

1. **audit-logger** — Logs all tool calls to `~/.openclaw/logs/audit.jsonl`
2. **response-verifier** — Verifies claims against audit log
   - Warning mode: Prepends `⚠️ VERIFICATION WARNING`
   - Strict mode: Blocks unverified responses

### Files Changed

- `src/plugins/types.ts` — Added hook types
- `src/plugins/hooks.ts` — Added `runBeforeResponse`
- `src/agents/pi-embedded-subscribe.handlers.messages.ts` — Wired hook
- `extensions/audit-logger/` — New plugin
- `extensions/response-verifier/` — New plugin

## Consequences

### Positive

- Independent audit trail of all agent actions
- Mechanical verification of completion claims
- Extensible pattern for other accountability requirements
- Warning mode allows gradual rollout

### Negative

- Additional latency (audit log reads)
- False positives possible with pattern matching
- Requires both plugins enabled to work

### Risks

- **Warning fatigue:** Too many false positives → ignored
- **Performance:** Log parsing may be slow at scale
- **Bypass:** Clever phrasing might evade detection

## Revisit Triggers

Switch approaches if:

1. Warning fatigue → Tune patterns or enable strict mode
2. Still missing issues → Add tool gating (Alternative 5)
3. Instructions ignored → Try mandatory skills (Alternative 2)
4. Performance issues → In-memory state vs log parsing

## Related

- GitHub Issues: #13131, #12563, #16026
- Plugins: `extensions/audit-logger/`, `extensions/response-verifier/`
