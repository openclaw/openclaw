# Phase 2: Input & Session Hardening - Research

**Researched:** 2026-02-15
**Domain:** Per-channel prompt injection detection, session isolation enforcement in multi-session LLM gateway
**Confidence:** HIGH

## Summary

Phase 2 has two distinct but related deliverables: (1) configurable per-channel input detection sensitivity (INPT-01) and (2) cross-session data isolation enforcement (SESS-01). Both requirements sit at the boundary between inbound message processing and the agent runtime, making them architecturally interconnected.

The codebase already has significant infrastructure relevant to both requirements. For input detection, `src/security/external-content.ts` implements `detectSuspiciousPatterns()` with a hardcoded set of regex patterns and `wrapExternalContent()` for content sandwiching. The security event system from Phase 1 (`src/security/events.ts` and `src/security/event-logger.ts`) already defines the `injection.detected` event type and `emitSecurityEvent()` function. The config system supports per-channel settings via `resolveChannelEntryMatchWithFallback()` in `src/channels/channel-config.ts` and the routing system in `src/routing/resolve-route.ts` resolves per-channel/peer/guild bindings. What's missing is: (a) a sensitivity/threshold configuration knob per channel, (b) a scoring system beyond binary pattern matching, and (c) configurable response actions (log/warn/block) based on the resolved sensitivity level.

For session isolation, the architecture already provides strong session key separation. Sessions are keyed via `agent:{agentId}:{rest}` patterns (see `src/routing/session-key.ts`), with per-agent storage directories (`state/agents/{agentId}/sessions/`). The `sessions_history` and `sessions_list` tools already implement agent-to-agent access control via `createAgentToAgentPolicy()` in `src/agents/tools/sessions-helpers.ts`, and sandboxed sessions restrict visibility to spawned children via `restrictToSpawned`. However, isolation is enforced at the tool policy layer, not the data access layer. A session with the right tool permissions could still request another session's transcript directly. The `memory_search` tool scopes by `agentId` but does not enforce session-level isolation within the same agent. The success criteria require isolation even when sessions share the same agent runtime process, which demands a systematic access control check at every data retrieval point.

**Primary recommendation:** (1) Add a `security.inputDetection` config section with per-channel sensitivity overrides that map to threshold multipliers for the existing pattern-matching system, plus configurable response actions; integrate the check into the inbound message processing pipeline. (2) Enforce session isolation by adding a `callerSessionKey` parameter to all transcript/memory access functions and validating access at the data layer rather than only at the tool dispatch layer.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (no new libraries) | n/a | Pattern-based injection detection | Existing `detectSuspiciousPatterns()` is the right approach for a local gateway; external API classifiers add latency and a network dependency |
| @sinclair/typebox | (already in use) | Config schema definitions | Used throughout the codebase for tool schemas |
| zod | (already in use) | Config validation schemas | Used for `openclaw.json` config schema validation |
| vitest | (already in use) | Testing | All new code needs colocated test files |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tslog / SubsystemLogger | (already in use) | Structured logging for security events | Security event emission via `emitSecurityEvent()` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Regex/heuristic detection | Lakera Guard API | Adds network dependency, latency (50-200ms), cost, and external trust requirement; can be added as optional later (v2 INPT-11) |
| Regex/heuristic detection | rebuff (protectai) | Python-based, requires separate process; not suitable for in-process TypeScript detection |
| Custom scoring | Embedding similarity to known attacks | Requires embedding model, high latency for per-message check; overkill for v1 |
| Tool-layer isolation | Process-level isolation (separate processes per session) | Massive architecture change; the Pi runtime is designed for in-process operation |

**Installation:**
No new packages needed. All required infrastructure exists in the codebase.

## Architecture Patterns

### Recommended Project Structure

```
src/
├── security/
│   ├── events.ts                  # EXISTING: SecurityEvent types (already has injection.detected)
│   ├── event-logger.ts            # EXISTING: emitSecurityEvent()
│   ├── external-content.ts        # MODIFY: Extend detectSuspiciousPatterns with scoring
│   ├── external-content.test.ts   # MODIFY: Add scored detection tests
│   ├── input-screening.ts         # NEW: Per-channel input screening pipeline
│   ├── input-screening.test.ts    # NEW: Tests for input screening
│   ├── session-access.ts          # NEW: Session data access authorization
│   └── session-access.test.ts     # NEW: Tests for session access control
├── config/
│   ├── zod-schema.security.ts     # NEW: Zod schema for security config section
│   ├── types.security.ts          # NEW: TypeScript types for security config
│   └── zod-schema.session.ts      # MODIFY: Add isolation config options
├── channels/
│   └── channel-config.ts          # EXISTING: Channel-level config resolution
├── agents/tools/
│   ├── sessions-history-tool.ts   # MODIFY: Add session-access check at data layer
│   ├── sessions-list-tool.ts      # MODIFY: Add session-access filtering
│   ├── sessions-helpers.ts        # MODIFY: Extend sandbox/isolation policy
│   └── memory-tool.ts             # MODIFY: Add session-scoped memory access
├── routing/
│   └── session-key.ts             # EXISTING: Session key parsing (reference for isolation)
```

### Pattern 1: Scored Input Detection with Per-Channel Thresholds

**What:** Extend the existing binary pattern detection to produce a numeric risk score (0.0-1.0), with per-channel threshold configuration that determines the response action.
**When to use:** Every inbound message before it reaches the agent runtime.
**Example:**

```typescript
// src/security/input-screening.ts

export type InputScreeningResult = {
  score: number; // 0.0-1.0 composite risk score
  matchedPatterns: string[];
  action: "allow" | "log" | "warn" | "block";
  sensitivity: InputSensitivity;
};

export type InputSensitivity = "lenient" | "moderate" | "strict";

export type InputDetectionConfig = {
  /** Default sensitivity when no channel override applies. */
  defaultSensitivity?: InputSensitivity;
  /** Per-channel sensitivity overrides. */
  channels?: Record<string, {
    sensitivity?: InputSensitivity;
  }>;
};

const SENSITIVITY_THRESHOLDS: Record<InputSensitivity, {
  logAt: number;    // Score at which to emit security event
  warnAt: number;   // Score at which to warn (include notice in context)
  blockAt: number;  // Score at which to block the message
}> = {
  lenient:  { logAt: 0.6, warnAt: 0.9, blockAt: 1.0 },  // Owner DMs
  moderate: { logAt: 0.3, warnAt: 0.6, blockAt: 0.9 },  // Trusted channels
  strict:   { logAt: 0.1, warnAt: 0.3, blockAt: 0.6 },  // Public channels
};

export function screenInput(params: {
  content: string;
  channel: string;
  sessionKey?: string;
  config: InputDetectionConfig;
}): InputScreeningResult {
  const sensitivity = resolveChannelSensitivity(params.channel, params.config);
  const thresholds = SENSITIVITY_THRESHOLDS[sensitivity];
  const { score, matchedPatterns } = computeRiskScore(params.content);

  let action: InputScreeningResult["action"] = "allow";
  if (score >= thresholds.blockAt) action = "block";
  else if (score >= thresholds.warnAt) action = "warn";
  else if (score >= thresholds.logAt) action = "log";

  if (action !== "allow") {
    emitSecurityEvent({
      eventType: "injection.detected",
      timestamp: new Date().toISOString(),
      sessionKey: params.sessionKey,
      channel: params.channel,
      severity: action === "block" ? "critical" : "warn",
      action,
      detail: `Score ${score.toFixed(2)} (${sensitivity}), ${matchedPatterns.length} pattern(s)`,
      meta: { score, patterns: matchedPatterns, sensitivity },
    });
  }

  return { score, matchedPatterns, action, sensitivity };
}
```

### Pattern 2: Session Data Access Authorization Layer

**What:** A centralized authorization function that validates whether a caller session has permission to access target session data. Called at every data retrieval boundary (transcript read, memory search, session list).
**When to use:** Before returning any session-scoped data from tools or internal APIs.
**Example:**

```typescript
// src/security/session-access.ts

export type SessionAccessDecision = {
  allowed: boolean;
  reason?: string;
};

export function authorizeSessionAccess(params: {
  callerSessionKey: string;
  targetSessionKey: string;
  accessType: "transcript" | "memory" | "metadata" | "list";
  config: OpenClawConfig;
}): SessionAccessDecision {
  // Same session: always allowed
  if (params.callerSessionKey === params.targetSessionKey) {
    return { allowed: true };
  }

  // Same agent: check cross-session policy
  const callerAgentId = resolveAgentIdFromSessionKey(params.callerSessionKey);
  const targetAgentId = resolveAgentIdFromSessionKey(params.targetSessionKey);

  if (callerAgentId === targetAgentId) {
    // Same agent sessions can see each other's metadata but NOT transcripts
    if (params.accessType === "metadata" || params.accessType === "list") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "Cross-session transcript/memory access denied within same agent",
    };
  }

  // Cross-agent: defer to agent-to-agent policy
  const a2aPolicy = createAgentToAgentPolicy(params.config);
  if (!a2aPolicy.isAllowed(callerAgentId, targetAgentId)) {
    return {
      allowed: false,
      reason: "Agent-to-agent access denied by tools.agentToAgent policy",
    };
  }

  return { allowed: true };
}
```

### Pattern 3: Channel Sensitivity Resolution via Existing Config Matching

**What:** Use the existing `resolveChannelEntryMatchWithFallback()` pattern to resolve per-channel sensitivity from the config, with wildcard and parent-key fallback.
**When to use:** When resolving which sensitivity level applies to an inbound message.
**Example:**

```typescript
// Uses existing channel-config matching patterns
function resolveChannelSensitivity(
  channel: string,
  config: InputDetectionConfig,
): InputSensitivity {
  const channelOverride = config.channels?.[channel.toLowerCase()];
  if (channelOverride?.sensitivity) {
    return channelOverride.sensitivity;
  }
  return config.defaultSensitivity ?? "moderate";
}
```

### Anti-Patterns to Avoid

- **Blocking at tool dispatch only:** The current agent-to-agent policy is enforced in tool handlers (`sessions-history-tool.ts`), not at the data retrieval layer. An attacker who can manipulate the agent into making raw file reads or memory queries bypasses this. Session isolation must be enforced at the lowest data access layer.
- **Global sensitivity for all channels:** Owner DMs and public Discord channels have fundamentally different trust levels. A global threshold either over-blocks trusted input or under-blocks untrusted input.
- **Adding external API dependencies for detection:** For a local gateway processing personal messages, adding network calls to external classification APIs (Lakera, Rebuff) introduces latency, cost, and a new trust boundary. This can be a v2 enhancement (INPT-11) but not the v1 approach.
- **Modifying the Pi agent runtime:** The `@mariozechner/pi-*` packages are a proprietary dependency. Session isolation must be enforced in the OpenClaw layer that wraps the runtime, not by patching the runtime itself.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Regex-based pattern matching | New regex engine | Existing `SUSPICIOUS_PATTERNS` in `external-content.ts` | Already battle-tested with Unicode homoglyph handling and marker sanitization |
| Config per-channel resolution | New config matching logic | Existing `resolveChannelEntryMatchWithFallback()` | Handles direct/parent/wildcard/normalized key matching |
| Security event emission | New logging pipeline | Existing `emitSecurityEvent()` from Phase 1 | Already routes through `SubsystemLogger` with severity-based routing |
| Session key parsing | New key format parser | Existing `parseAgentSessionKey()` | Handles all session key formats (agent, subagent, cron, ACP) |
| Agent-to-agent access control | New ACL system | Existing `createAgentToAgentPolicy()` | Already implements pattern-based allow/deny with wildcard support |

**Key insight:** The codebase has almost all the building blocks. The work is (a) wiring them together with a scoring/threshold layer for input detection, and (b) pushing the existing access control checks down from the tool layer to the data access layer for session isolation.

## Common Pitfalls

### Pitfall 1: Over-Blocking Owner DMs

**What goes wrong:** Setting detection sensitivity too high for trusted channels (owner DMs) causes false positives. The owner asking "ignore my previous message about X" or "you are now going to help me with Y" gets flagged as injection.
**Why it happens:** Injection patterns overlap heavily with normal conversational language.
**How to avoid:** Default DM sensitivity to "lenient" with high thresholds. The lenient profile should only block at very high scores (multiple strong indicators). Test with real conversational examples.
**Warning signs:** Owner reports that normal messages are being blocked or flagged.

### Pitfall 2: Incomplete Isolation Surface

**What goes wrong:** Adding access checks to `sessions_history` and `sessions_list` tools but missing the `memory_search` tool, direct transcript file reads via `memory_get`, or the `chat.history` gateway method.
**Why it happens:** Session data is accessible through multiple paths: tool calls, gateway RPC methods, direct file system reads, and memory search.
**How to avoid:** Enumerate ALL data access paths by searching for `loadSessionStore`, `resolveSessionFilePath`, `resolveSessionTranscriptPath`, `callGateway` with `sessions.*` or `chat.history` methods, and `getMemorySearchManager`. Add access control at each boundary.
**Warning signs:** Test specifically for cross-session access via each distinct path.

### Pitfall 3: Scoring System That Doesn't Scale

**What goes wrong:** Building an elaborate ML-based scoring system that's hard to test, debug, and maintain.
**Why it happens:** Desire for sophistication over pragmatism.
**How to avoid:** Use weighted pattern matching: each pattern has a base score (0.1-0.5), patterns compound, and the composite score determines the action. Keep it deterministic and testable. External classifiers can be a v2 feature (INPT-11).
**Warning signs:** If you can't write a unit test that deterministically produces a specific score, the system is too complex.

### Pitfall 4: Config Schema Drift

**What goes wrong:** Adding a new config section (`security.inputDetection`) that doesn't follow existing config patterns, breaks schema validation, or isn't accessible from the UI.
**Why it happens:** The config system uses Zod schemas (`src/config/zod-schema.*.ts`) with UI hints (`src/config/schema.hints.ts`). New config sections need all three: Zod schema, TypeScript types, and UI hints.
**How to avoid:** Follow the exact pattern used for existing config sections (e.g., `session.*`, `tools.*`). Add to `zod-schema.ts`, create types in `types.*.ts`, register hints in `schema.hints.ts`.
**Warning signs:** `bun run check` fails on config validation; UI doesn't show new settings.

### Pitfall 5: Breaking Existing Agent-to-Agent Functionality

**What goes wrong:** Session isolation enforcement blocks legitimate cross-agent communication that was previously working (via `tools.agentToAgent` config).
**Why it happens:** Overly strict isolation that doesn't respect the existing A2A policy.
**How to avoid:** The access authorization function must first check if the caller and target are the same session (always allowed), then check same-agent cross-session policy, then defer to the existing A2A policy for cross-agent access. Never be more restrictive than the current A2A system for cross-agent cases.
**Warning signs:** E2E tests in `src/agents/openclaw-tools.sessions.e2e.test.ts` and `sessions-list-tool.gating.e2e.test.ts` fail.

## Code Examples

Verified patterns from the existing codebase:

### Existing Injection Detection (src/security/external-content.ts)

```typescript
// Current implementation: binary match, no scoring
const SUSPICIOUS_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /new\s+instructions?:/i,
  /system\s*:?\s*(prompt|override|command)/i,
  // ... more patterns
];

export function detectSuspiciousPatterns(content: string): string[] {
  const matches: string[] = [];
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(pattern.source);
    }
  }
  return matches;
}
```

### Existing Security Event Emission (src/security/event-logger.ts)

```typescript
import type { SecurityEvent } from "./events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const securityLogger = createSubsystemLogger("security");

export function emitSecurityEvent(event: SecurityEvent): void {
  const { severity, eventType, ...meta } = event;
  const message = `[${eventType}] ${event.action}${event.detail ? `: ${event.detail}` : ""}`;

  if (severity === "critical") {
    securityLogger.error(message, meta);
  } else if (severity === "warn") {
    securityLogger.warn(message, meta);
  } else {
    securityLogger.info(message, meta);
  }
}
```

### Existing Agent-to-Agent Policy Check (src/agents/tools/sessions-helpers.ts)

```typescript
export function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy {
  const routingA2A = cfg.tools?.agentToAgent;
  const enabled = routingA2A?.enabled === true;
  const allowPatterns = Array.isArray(routingA2A?.allow) ? routingA2A.allow : [];
  // Pattern matching with wildcard support
  const isAllowed = (requesterAgentId: string, targetAgentId: string) => {
    if (requesterAgentId === targetAgentId) return true;
    if (!enabled) return false;
    return matchesAllow(requesterAgentId) && matchesAllow(targetAgentId);
  };
  return { enabled, isAllowed };
}
```

### Existing Session Key Structure (src/routing/session-key.ts)

```typescript
// Session keys follow the pattern: agent:{agentId}:{rest}
// Examples:
//   agent:main:main                              (main DM session)
//   agent:main:telegram:direct:12345             (per-peer DM)
//   agent:main:discord:group:server123           (group session)
//   agent:coding-assistant:main                  (different agent)

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}
```

### Existing Cross-Agent Check in sessions_history (src/agents/tools/sessions-history-tool.ts)

```typescript
// Current: access control at tool layer only
const a2aPolicy = createAgentToAgentPolicy(cfg);
const requesterAgentId = resolveAgentIdFromSessionKey(requesterInternalKey);
const targetAgentId = resolveAgentIdFromSessionKey(resolvedKey);
const isCrossAgent = requesterAgentId !== targetAgentId;
if (isCrossAgent) {
  if (!a2aPolicy.enabled) {
    return jsonResult({ status: "forbidden", error: "..." });
  }
  if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
    return jsonResult({ status: "forbidden", error: "..." });
  }
}
// Missing: cross-session check WITHIN same agent
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Binary pattern matching | Weighted pattern scoring with thresholds | Becoming standard 2024-2025 | Enables per-channel tuning without pattern list changes |
| Tool-level access control | Data-layer access control | OWASP LLM Top 10 2025 | Prevents bypass via alternative data paths |
| Global injection detection | Per-context sensitivity tiers | 2024+ (multi-tenant LLM apps) | Reduces false positives while maintaining security for untrusted channels |
| External API classifiers | Hybrid: local heuristics + optional external | 2025 | Removes latency/cost for most messages; escalate only when needed |

**Deprecated/outdated:**
- Simple keyword blocklists without scoring: too many false positives/negatives
- Global sensitivity settings for multi-channel systems: inadequate for mixed trust environments

## Open Questions

1. **Where exactly in the inbound pipeline should screening run?**
   - What we know: Messages flow through `src/auto-reply/dispatch.ts` -> `src/auto-reply/reply.ts` -> `src/auto-reply/reply/get-reply.ts`. The `wrapExternalContent()` function is called for hook/cron sessions but NOT for regular channel messages.
   - What's unclear: The exact hook point for screening regular inbound messages before they reach the agent. Need to trace the full path from channel adapter -> dispatch -> reply.
   - Recommendation: During planning, trace the dispatch path and identify the earliest common point for all channels. Likely in `dispatch.ts` or `reply.ts` before the agent turn starts.

2. **Should session isolation apply within the same agent's sessions?**
   - What we know: The success criteria say "Session A requesting Session B's transcript returns an error." The A2A policy currently only checks cross-agent access.
   - What's unclear: Does the user want peer DM session A (telegram:direct:alice) to be unable to read peer DM session B (telegram:direct:bob)?
   - Recommendation: Default to enforcing isolation between peer sessions within the same agent. This is the strictest interpretation and the safest. The gateway/main session can be exempted as it's the administrative context. Add a config option `session.crossSessionAccess` to relax if needed.

3. **How should "block" action work for high-sensitivity channels?**
   - What we know: The success criteria say the system should apply "the configured response action (log, warn, or block)."
   - What's unclear: What does "block" mean in the message flow? Drop the message silently? Return a canned response? Emit to the channel?
   - Recommendation: "block" should prevent the message from reaching the agent, emit a security event, and return a brief, configurable rejection message to the channel (e.g., "Message blocked by security policy").

4. **Memory search session scoping granularity**
   - What we know: `memory_search` currently scopes to `agentId` level. The `sessionKey` is passed as a parameter for session-aware indexing but not for access control.
   - What's unclear: Should memory search results be filtered to only show chunks from the caller's own session transcripts, or should all sessions within the same agent share memory?
   - Recommendation: Memory files (`MEMORY.md`, `memory/*.md`) should remain shared within an agent (they are global knowledge). Session transcript chunks in memory search should be filtered to the caller's own session transcripts only, unless the A2A policy allows cross-agent access.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/security/external-content.ts` - existing injection detection patterns and `wrapExternalContent()` implementation
- Codebase analysis: `src/security/events.ts` + `src/security/event-logger.ts` - Phase 1 security event system
- Codebase analysis: `src/routing/session-key.ts` - session key structure and parsing
- Codebase analysis: `src/agents/tools/sessions-history-tool.ts` - existing A2A policy enforcement at tool layer
- Codebase analysis: `src/agents/tools/sessions-helpers.ts` - sandbox policy, A2A policy, session tool context
- Codebase analysis: `src/agents/tools/memory-tool.ts` - memory search scoping by agentId
- Codebase analysis: `src/config/sessions/store.ts` - session store data access patterns
- Codebase analysis: `src/config/sessions/paths.ts` - session file path resolution with agent scoping
- Codebase analysis: `src/channels/channel-config.ts` - per-channel config resolution patterns
- Codebase analysis: `src/config/types.tools.ts` - existing `agentToAgent` config schema

### Secondary (MEDIUM confidence)
- [Giskard - Cross Session Leak](https://www.giskard.ai/knowledge/cross-session-leak-when-your-ai-assistant-becomes-a-data-breach) - cross-session data leakage vulnerability patterns and prevention
- [OWASP LLM Top 10 2025](https://www.brightdefense.com/resources/owasp-top-10-llm/) - prompt injection as #1 risk, session isolation as key defense
- [The Sandboxed Mind - Principled Isolation Patterns](https://medium.com/@adnanmasood/the-sandboxed-mind-principled-isolation-patterns-for-prompt-injection-resilient-llm-agents-c14f1f5f8495) - isolation architecture patterns for LLM agents

### Tertiary (LOW confidence)
- [protectai/rebuff](https://github.com/protectai/rebuff) - Python-based prompt injection detector (not directly applicable, but useful pattern reference)
- [BlueprintLabIO/prompt-injector](https://github.com/BlueprintLabIO/prompt-injector) - TypeScript injection attack patterns for testing

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new libraries needed; all building blocks exist in codebase
- Architecture (input detection): HIGH - existing patterns, scoring system, and config infrastructure are well-understood
- Architecture (session isolation): HIGH - session key structure, storage paths, and access patterns thoroughly mapped
- Pitfalls: HIGH - identified from codebase analysis of existing access control gaps and config patterns

**Research date:** 2026-02-15
**Valid until:** 2026-03-15 (stable domain; no fast-moving dependencies)
