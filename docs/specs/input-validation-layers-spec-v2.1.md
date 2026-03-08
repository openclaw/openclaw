# Input Validation Layers

### OpenClaw · Feature Spec v2.3

### Extension of: Transcript Sanitization Subagent for Session Memory + MCP Trust Tier

---

## Changelog (v2.1 → v2.2)

| Issue                                                                                                     | Resolution                                                                              |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `TRANSCRIPT_ALLOWED_FIELDS` listed 5 fields; implementation has 17                                        | Updated allowlist to match implementation (added expiresAt, from, to, channelId, etc.). |
| Frequency weight keys used stale names (`schema.extra-fields`, `schema.missing-required`)                 | Corrected to `schema.extra-field`, `schema.missing-field` to match implementation.      |
| `schema.no-discriminant` weight listed in spec; not present in implementation `DEFAULT_FREQUENCY_WEIGHTS` | Removed `schema.no-discriminant` entry from default weights table.                      |

## Changelog (v2.2 → v2.3)

| Issue                                                                                                                            | Resolution                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture section stated Stage 1A/1B run "concurrently via `Promise.all`"; both are synchronous functions called sequentially | Corrected. `runPreFilter` calls `syntacticPreFilter` then `schemaValidation` sequentially. Both are pure synchronous functions; `async` wrapper is for API consistency only. |
| `SessionSuspicionState` type missing `terminated` field set at tier-3 escalation                                                 | Added `terminated?: boolean` to type. Set to `true` when score crosses `thresholds.tier3`; subsequent calls return `tier3` immediately.                                      |
| Default frequency weights listed `"encoding.*": 5`; not present in `DEFAULT_FREQUENCY_WEIGHTS` in config.ts                      | Removed. Also added missing `"schema.undeclared-admin-reject": 4` which is in the implementation.                                                                            |

## Changelog (v2 → v2.1)

| Issue                                                                                                  | Resolution                                                                             |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `SchemaValidationResult` returned free-text `violations` but no rule IDs from the audit trail taxonomy | Added `ruleIds: string[]` to output type with mapping to `schema.*` rule IDs.          |
| Semantic sub-agent rule IDs existed in audit trail taxonomy but had no detection spec                  | Added Semantic Sub-Agent Rule IDs section listing all rules the sub-agent must detect. |
| `scope-creep.unexpected-field` duplicated `schema.extra-field`                                         | Consolidated under `schema.extra-field` (matches audit trail spec v2.1).               |

---

## Summary

Add a two-stage input validation layer that runs before the sanitization sub-agent
for both transcript-origin and MCP-origin content. Stage one is a fast syntactic
pre-filter and schema validator that runs in parallel — catching known patterns,
structural violations, and schema mismatches without a model call. Stage two is
the existing semantic sub-agent pass. A two-pass architecture is also specified as
an optional cost-optimization path that gates the full semantic pass on Stage 1
results.

All components (syntactic pre-filter, schema validation, two-pass gating) are
intended to be implemented together. They are complementary, not alternatives.

---

## Design Goals

- **Defense in depth.** Syntactic filters catch known low-effort attacks cheaply.
  Schema validation enforces structural contracts. Semantic inspection catches
  novel attacks that earlier stages miss. No single stage is sufficient alone.
- **Fail closed.** A validation failure at any stage blocks content from reaching
  the manager context. No silent pass-through on error.
- **Non-blocking on transcript path.** Pre-filter stages run synchronously before
  the sub-agent, but the full write path remains fire-and-forget from the reply
  perspective.
- **Blocking on MCP path.** Both validation stages are synchronous for untrusted
  MCP results — same as the existing sanitization hop.
- **Cost-aware.** The two-pass pattern avoids spinning up the full semantic
  sub-agent for content that fails pre-filter checks, reducing model calls on
  obviously malicious or malformed inputs.

---

## Architecture

```
Input arrives (transcript or MCP result)
        ↓
Stage 1: Parallel Pre-Filter (fast, no model call)
  ┌─────────────────────┬──────────────────────────┐
  │ Syntactic Filter     │ Schema Validation         │
  │ (pattern matching)   │ (structural/type checks)  │
  └─────────┬───────────┴────────────┬───────────────┘
            └───────── merge ────────┘
                       ↓
        ┌── ANY FAIL → block, audit entry, return safe result
        │   (if twoPass.enabled and definitive FAIL, skip Stage 2)
        └── ALL PASS → continue
                       ↓
Stage 2: Semantic Sub-Agent (existing sanitization helper)
  ├── safe: false → block, audit entry, return safe result
  └── safe: true → pass structuredResult to manager
```

Syntactic filtering and schema validation are both pure synchronous functions.
`runPreFilter` calls them sequentially and merges their results before the
two-pass gating decision. The `async` wrapper on `runPreFilter` is for API
consistency only — no concurrency is involved. Neither stage depends on the
other's output.

The two-pass cost optimization is an optional config flag that skips Stage 2
entirely when Stage 1 produces a definitive FAIL. When disabled, both stages
always run in sequence.

---

## Stage 1A — Syntactic Pre-Filter

A pure TypeScript function, no model call. Runs in parallel with schema
validation.

### What it checks

**Known injection patterns (low-effort attack filter):**

This pattern list is designed to catch automated and low-effort injection
attempts. It is not a comprehensive injection detector. Sophisticated
adversaries can bypass these patterns using techniques including but not
limited to: line breaks mid-word, zero-width Unicode characters, markdown
formatting injection, leetspeak substitution, multilingual rephrasing, and
whitespace manipulation. The semantic sub-agent (Stage 2) is the primary
defense against novel and obfuscated attacks.

Patterns detected (case-insensitive):

- `ignore previous instructions`
- `ignore all instructions`
- `disregard your`
- `you are now`
- `new instructions:`
- `system override`
- `SYSTEM:` (all-caps prefix)
- `[INST]` / `</INST>` (instruction delimiters from common model formats)

Role-switching attempts — any of the following combined with a
capability-granting phrase:

- Trigger phrases: `you are a`, `act as`, `pretend you are`, `roleplay as`
- Capability grants: `no restrictions`, `no limits`, `without filters`,
  `DAN mode`, `developer mode`

**Structural anomalies:**

- Payload exceeds configured size limit (`syntactic.maxPayloadBytes`,
  default 512KB)
- Nested JSON depth exceeding configured threshold (default: 10 levels)
- Binary or non-UTF8 content in text fields

**Encoding tricks:**

- Base64-encoded content in unexpected text fields (not image source fields)
- Unicode homoglyph substitution in common injection phrases (basic pass)
- Null byte injection

### Output

```typescript
type SyntacticFilterResult = {
  pass: boolean;
  flags: string[]; // human-readable descriptions of what triggered
  ruleIds: string[]; // machine-readable rule identifiers for audit
};
```

### What this filter does NOT catch

For clarity, the following classes of attack are explicitly outside the
syntactic filter's capability and are handled by the semantic sub-agent:

- Obfuscated injection using zero-width characters, line breaks, or
  whitespace manipulation
- Multilingual injection (instructions in non-English languages)
- Leetspeak or character substitution beyond basic homoglyphs
- Context-dependent attacks (e.g., injection phrases in quoted or
  educational content)
- Instruction-like content that requires intent analysis to classify
  (previously listed as "instruction-to-content token ratio" — moved to
  Stage 2 semantic analysis where a model can judge intent)
- Novel injection patterns not present in the rule set

### False positive policy

Syntactic filters are intentionally conservative — they will produce false
positives on legitimate content that contains instruction-like phrases in
quoted or educational contexts. The semantic sub-agent is the final arbiter.
A syntactic FAIL does not necessarily mean the content is blocked — see
two-pass config below for how to tune this behavior.

---

## Stage 1B — Schema Validation

Structural validation of the input against the expected shape for its source
type. No model call. Runs in parallel with syntactic pre-filter.

### Transcript-origin validation

Uses a **strict allowlist** of permitted top-level fields. Any field not in
the allowlist causes a validation failure. This requires the allowlist to be
updated when the transcript schema evolves — this is an intentional
maintenance cost accepted in exchange for payload injection prevention.

Allowed fields:

```typescript
const TRANSCRIPT_ALLOWED_FIELDS = [
  "messageId", // required, non-empty string
  "timestamp", // required, ISO 8601
  "expiresAt", // optional, ISO 8601
  "transcript", // required, non-empty string
  "body", // optional, string
  "bodyForAgent", // optional, string
  "from", // optional, string
  "to", // optional, string
  "channelId", // optional, string
  "conversationId", // optional, string
  "senderId", // optional, string
  "senderName", // optional, string
  "senderUsername", // optional, string
  "provider", // optional, string
  "surface", // optional, string
  "mediaPath", // optional, string
  "mediaType", // optional, string
] as const;
```

Failures:

- `messageId` missing or empty
- `transcript` field is not a string or is empty
- `timestamp` not parseable as ISO 8601
- Any top-level field not present in `TRANSCRIPT_ALLOWED_FIELDS`

When the transcript schema evolves, the allowlist must be updated in the
same PR that adds the new field. CI should enforce that new transcript
fields are added to both the schema definition and the validation allowlist.

### MCP-origin validation — Discriminated unions

MCP tool responses are validated against the tool's declared output schema.
Tools that return polymorphic responses must declare **discriminated union**
schemas.

**Discriminated union requirements:**

- The response must include a discriminant field (e.g., `"type"`,
  `"status"`, `"resultKind"`) declared in the tool's output schema
- Each variant declares its own field set and types
- The validator reads the discriminant field first, selects the matching
  variant schema, then validates the full response against that variant

Example tool schema declaration:

```typescript
{
  outputSchema: {
    discriminant: "type",
    variants: {
      paginated: {
        type: { const: "paginated" },
        items: "array",
        nextCursor: "string | null",
        totalCount: "number"
      },
      single: {
        type: { const: "single" },
        result: "object"
      },
      empty: {
        type: { const: "empty" },
        message: "string"
      }
    }
  }
}
```

**Validation logic:**

1. Read the discriminant field from the response
2. If the discriminant value does not match any declared variant → FAIL
3. Select the matching variant schema
4. Validate all response fields against the variant (type checks, required
   fields, no extra fields beyond the variant's declaration)

**Tools without discriminated union schemas:**

- If a tool declares a single (non-union) output schema, validate against
  it strictly — no extra fields, types must match
- If a tool declares no output schema at all, apply strictest fallback:
  response must be a JSON object or array (no bare strings, numbers, or
  null), size within configured limit, and the response proceeds to the
  semantic pass for full inspection

**Tools that cannot provide a discriminant field:**

- Treated as single-schema tools with the strictest validation applied
- Schema mismatches fall through to the semantic sub-agent with a flag
  noting the tool lacks discriminated output

### Output

```typescript
type SchemaValidationResult = {
  pass: boolean;
  violations: string[]; // human-readable description of each schema violation
  ruleIds: string[]; // machine-readable rule IDs from audit trail taxonomy
};
```

Schema violations map to rule IDs from the audit trail rule taxonomy:

- Missing required field → `schema.missing-field`
- Field type mismatch → `schema.type-mismatch`
- Unexpected/undeclared field → `schema.extra-field`

This ensures the audit subsystem can fan out schema violations into
`rule_triggered` events with correct `ruleCategory` values without
parsing free-text violation strings.

---

## Semantic Sub-Agent Rule IDs

The semantic sub-agent (Stage 2) is responsible for detecting rule categories
that require intent analysis — patterns that cannot be reliably identified by
syntactic pattern matching or structural validation alone.

The sub-agent must return detected rule IDs in its output using the same
`category.subcategory` format defined in the audit trail rule taxonomy. The
following rule IDs are detected exclusively by the semantic sub-agent:

| Rule ID                             | Description                                                             |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `injection.direct-address`          | Content that addresses the agent directly with manipulative intent      |
| `injection.role-switch-only`        | Role-switch phrase without capability grant (ambiguous without context) |
| `credential.api-key-pattern`        | API key shaped content in transcript or tool results                    |
| `credential.password-pattern`       | Password field or assignment pattern                                    |
| `credential.env-var-pattern`        | Environment variable assignment                                         |
| `scope-creep.permission-escalation` | Content requesting elevated permissions                                 |
| `scope-creep.cross-agent-reference` | Reference to another agent's data                                       |
| `semantic.safe-false`               | Sub-agent's general safety judgment (catch-all)                         |
| `semantic.low-confidence`           | Sub-agent confidence below threshold                                    |
| `semantic.malformed-output`         | Sub-agent output itself failed schema validation                        |

The sub-agent also performs the intent analysis that the syntactic filter
explicitly cannot: distinguishing injection phrases in quoted/educational
contexts from actual injection attempts, evaluating multilingual and obfuscated
injection, and assessing instruction-like content ratios.

When syntactic flags are passed to the semantic sub-agent (via the two-pass
flags-only path), the sub-agent should use them as hints but make its own
independent judgment. The sub-agent may confirm or override syntactic flags.

---

## Within-Session Frequency Tracking

Exponential decay scoring tracks accumulated suspicion within a session. Each
syntactic flag or schema violation adds to a per-session score that decays
over time. When the score crosses configured thresholds, the session's trust
posture escalates through defined tiers.

### Algorithm

```
currentScore = previousScore × e^(-elapsed / halfLife) + newFlagWeight
```

**Per-session state:**

```typescript
type SessionSuspicionState = {
  lastScore: number; // cumulative decayed score
  lastUpdateMs: number; // timestamp of last score update
  terminated?: boolean; // set to true when score crosses thresholds.tier3
};
```

Once `terminated` is set, `updateFrequencyScore` returns `tier3` immediately on
every subsequent call regardless of the current score or elapsed time. Subsequent
turns in the terminated session are blocked at the frequency gate without updating
the score.

**Update procedure** (O(1) per event):

1. Compute elapsed time since `lastUpdateMs`
2. Decay `lastScore` by `e^(-elapsed / halfLife)`
3. Add the weight for the current flag/violation
4. Store updated `lastScore` and current timestamp
5. Compare `lastScore` against escalation thresholds

**Default configuration:**

```
memory.sessions.sanitization.frequency.enabled: boolean
  Default: true

memory.sessions.sanitization.frequency.halfLifeMs: number
  Default: 60000 (60 seconds)
  Time in milliseconds for a flag's contribution to decay to half weight.

memory.sessions.sanitization.frequency.weights: Record<string, number>
  Default:
    "injection.*":                    10
    "structural.*":                    5
    "schema.extra-field":              8
    "schema.type-mismatch":            6
    "schema.missing-field":            4
    "schema.undeclared-admin-reject":  4

memory.sessions.sanitization.frequency.thresholds: object
  Default:
    tier1: 15    // force full semantic pass
    tier2: 30    // add extra scrutiny context to semantic prompt
    tier3: 50    // terminate session
```

### Escalation tiers

**Tier 1 — Force full semantic pass** (score ≥ threshold.tier1):

- Overrides `twoPass.enabled` for this session — all inputs go through the
  semantic sub-agent regardless of syntactic/schema results
- Audit event: `frequency_escalation_tier1`

**Tier 2 — Enhanced semantic scrutiny** (score ≥ threshold.tier2):

- All Tier 1 behavior, plus:
- The semantic sub-agent receives additional context:
  ```
  [session frequency alert: elevated injection pattern frequency detected.
   Apply heightened scrutiny. Recent flags: <flag summary>]
  ```
- Audit event: `frequency_escalation_tier2`

**Tier 3 — Session termination** (score ≥ threshold.tier3):

- Session is terminated and marked as compromised
- No further inputs accepted on this session
- Manager receives a structured notification of forced termination
- Audit event: `frequency_escalation_tier3`

### Decay properties

The exponential decay approach has the following properties relevant to
security:

- **No cliff effect.** Unlike sliding windows, old events fade smoothly
  rather than dropping off abruptly at a boundary an attacker could time
  around.
- **O(1) storage and computation.** Two floats per session. No arrays of
  timestamps, no window management.
- **Sustained low-level probing is detected.** Even small flags accumulate
  if they arrive faster than the decay rate. An attacker sending a flag-2
  event every 10 seconds against a 60-second half-life will accumulate to
  tier 1 within about a minute.
- **Legitimate one-off flags are forgiven.** A single flag-5 event decays
  below tier 1 threshold (15) immediately since it never reaches it, and
  fades to ~2.5 within one half-life.

---

## Two-Pass Cost Optimization (Optional)

Config flag: `memory.sessions.sanitization.twoPass.enabled` (default: `false`)

When enabled:

- If Stage 1A or Stage 1B produces a definitive FAIL (not just flags), skip
  the semantic sub-agent entirely and return blocked result immediately
- If Stage 1A produces flags but not a definitive FAIL, continue to Stage 2
  with the flags passed into the sub-agent's input context as hints
- If both Stage 1A and Stage 1B PASS cleanly, continue to Stage 2 normally
- **Exception:** If frequency tracking has escalated to Tier 1 or above, the
  semantic sub-agent always runs regardless of two-pass config

**Definitive FAIL** is defined as:

- Any structural violation from Stage 1B (schema validation)
- Any injection pattern from Stage 1A `ruleIds` that is in the configured
  `twoPass.hardBlockRules` list

**Flags-only FAIL** proceeds to Stage 2 with the syntactic flags injected as
additional context for the semantic pass:

```
[syntactic flags: role-switching phrase detected, possible injection attempt]
```

This allows the semantic sub-agent to weight its judgment with prior signal
rather than operating blind.

---

## Config Surface

Extend `memory.sessions.sanitization` with:

```
memory.sessions.sanitization.syntactic.enabled: boolean
  Default: true
  Controls whether the syntactic pre-filter runs.

memory.sessions.sanitization.syntactic.maxPayloadBytes: number
  Default: 524288 (512KB)
  Maximum raw payload size before syntactic block.

memory.sessions.sanitization.syntactic.maxJsonDepth: number
  Default: 10
  Maximum nested JSON depth before structural block.

memory.sessions.sanitization.schema.enabled: boolean
  Default: true
  Controls whether schema validation runs.

memory.sessions.sanitization.twoPass.enabled: boolean
  Default: false
  When true, definitive syntactic/schema failures skip the semantic sub-agent.

memory.sessions.sanitization.twoPass.hardBlockRules: string[]
  Default: ["injection.ignore-previous", "injection.system-override",
            "injection.role-switch-capability"]
  Rule IDs that trigger definitive block in two-pass mode without semantic pass.

memory.sessions.sanitization.frequency.enabled: boolean
  Default: true
  Controls whether within-session frequency tracking is active.

memory.sessions.sanitization.frequency.halfLifeMs: number
  Default: 60000
  Half-life for exponential decay scoring in milliseconds.

memory.sessions.sanitization.frequency.weights: Record<string, number>
  Default: see frequency tracking section above.
  Weight assigned to each flag/violation category.

memory.sessions.sanitization.frequency.thresholds.tier1: number
  Default: 15
  Score threshold to force full semantic pass.

memory.sessions.sanitization.frequency.thresholds.tier2: number
  Default: 30
  Score threshold to add enhanced scrutiny context.

memory.sessions.sanitization.frequency.thresholds.tier3: number
  Default: 50
  Score threshold to terminate session.
```

---

## Audit Integration

Every validation stage appends to the existing session audit log.

### Validation event types

```
event: "syntactic_pass" | "syntactic_fail" | "syntactic_flags"
  flags: string[]
  ruleIds: string[]
  messageId or toolCallId

event: "schema_pass" | "schema_fail"
  violations: string[]
  messageId or toolCallId

event: "twopass_hard_block"
  ruleIds: string[]
  messageId or toolCallId
  reason: "skipped semantic pass — hard block rule triggered"

event: "frequency_escalation_tier1" | "frequency_escalation_tier2" |
       "frequency_escalation_tier3"
  currentScore: number
  threshold: number
  recentFlags: string[]
  sessionId
```

The existing `sanitized_pass`, `sanitized_block`, and `write_failed` events
remain unchanged. The new events appear before them in the audit log for the
same turn, providing a complete per-turn validation chain.

### Audit contract for downstream consumers

This spec exposes the following signals for consumption by an alerting or
monitoring layer (see companion spec: `audit-alerting-spec.md`):

| Signal                     | Event type(s)                         | Meaning                                                           |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| Injection attempt detected | `syntactic_fail`, `syntactic_flags`   | Known injection pattern matched. Severity indicated by `ruleIds`. |
| Schema violation           | `schema_fail`                         | Input structurally invalid for its source type.                   |
| Semantic block             | `sanitized_block` (existing)          | Model judged content unsafe after semantic analysis.              |
| Cost optimization skip     | `twopass_hard_block`                  | Semantic pass was skipped due to definitive pre-filter failure.   |
| Session suspicion rising   | `frequency_escalation_tier1`, `tier2` | Accumulated flag score crossed escalation threshold.              |
| Session terminated         | `frequency_escalation_tier3`          | Session killed due to sustained suspicious input.                 |

Downstream consumers should treat `frequency_escalation_tier2` and above as
operator-alertable events. See `audit-alerting-spec.md` for threshold
definitions and delivery mechanisms.

---

## Storage

No new persistent storage structures needed. All events append to the
existing per-session audit JSONL at:

```
~/.openclaw/agents/<agentId>/session-memory/audit/<sessionId>.jsonl
```

Within-session frequency state (`lastScore`, `lastUpdateMs`, `terminated`) is
held in memory for the duration of the session. It is not persisted — session
restart resets the frequency score and terminated flag. This is acceptable
because session restart also resets the attack surface.

---

## Implementation Notes

**Syntactic filter is stateless.** It is a pure function with no I/O, no model
calls, and no external dependencies. It can be unit tested exhaustively with
fixture inputs. The rule set is defined as a versioned constant, not loaded
from config at runtime (to avoid config-injection attacks on the filter itself).

**Schema validation uses query.json as baseline for MCP.** The tool call that
produced the result is already materialized in the sub-agent's temp workspace.
The schema validator reads it before the sub-agent does, using it as the
expected-output contract.

**Parallel execution.** Syntactic filtering and schema validation share no
state and operate on different aspects of the input. They execute concurrently
via `Promise.all` and their results are merged before the two-pass gating
decision.

**Frequency state is per-session, in-memory only.** The exponential decay
scorer holds two floats per session in a `Map<sessionId, SessionSuspicionState>`.
No disk I/O on the hot path.

**Transcript allowlist maintenance.** When adding new fields to the transcript
schema, the corresponding entry must be added to `TRANSCRIPT_ALLOWED_FIELDS`
in the same change. CI enforcement is recommended (a test that compares the
schema definition's keys against the allowlist).

**Syntactic rule set is not the security boundary.** It is a low-effort-attack
filter only. The semantic sub-agent remains the primary trust decision.
Operators should not disable the semantic pass based on syntactic PASS results
alone.

---

## Tests

**Syntactic pre-filter:**

- Known injection phrases trigger correct ruleIds
- Clean content passes with empty flags
- Oversized payload triggers structural block
- Excessive JSON depth triggers structural block
- Base64 in unexpected text field triggers flag
- Unicode homoglyph substitution in injection phrase is detected
- Rule set is immutable at runtime (cannot be modified via config injection)

**Schema validation:**

- Well-formed transcript passes
- Missing messageId fails with correct violation
- Transcript with unexpected top-level field fails (strict allowlist)
- MCP result with valid discriminant and matching variant passes
- MCP result with unknown discriminant value fails
- MCP result with extra fields beyond variant declaration fails
- MCP result with mismatched field types fails
- Tool without declared schema accepts JSON object, rejects bare string
- Tool without discriminated union gets strictest single-schema validation

**Parallel execution:**

- Both filters execute concurrently (timing test: total time ≈ max of
  individual times, not sum)
- Merged results contain entries from both filters
- Failure in either filter triggers correct gating behavior

**Frequency tracking:**

- Single flag below tier 1 threshold does not escalate
- Rapid repeated flags accumulate past tier 1 threshold
- Score decays correctly over time (flag followed by pause returns to
  baseline)
- Tier 1 escalation forces semantic pass even with twoPass enabled
- Tier 2 escalation injects scrutiny context into semantic prompt
- Tier 3 escalation terminates session
- Session restart resets frequency state

**Two-pass gating:**

- Hard block rule triggers skip of semantic pass
- Flags-only result proceeds to semantic pass with flag context injected
- Clean syntactic + schema pass proceeds to semantic pass normally
- twoPass disabled: semantic pass always runs regardless of earlier results
- Frequency tier 1+ overrides twoPass skip behavior

**Audit:**

- Per-stage audit entries appear in correct order for same turn
- syntactic_fail entry contains ruleIds
- schema_fail entry contains violations
- twopass_hard_block entry contains reason
- frequency_escalation entries contain currentScore and threshold

**Integration:**

- Full chain: injection phrase → syntactic_fail → twopass_hard_block → no
  sub-agent invoked → manager receives safe blocked result
- Full chain: clean input → syntactic_pass → schema_pass → sub-agent →
  safe: true → manager receives structuredResult
- Full chain: repeated borderline flags → frequency tier 1 → forced semantic
  pass → sub-agent catches attack that syntactic filter missed

---

## Residual Risks (Accepted)

| Risk                                                             | Status                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Novel injection patterns not in syntactic rule set               | Accepted. Syntactic filter is a low-effort-attack gate only. Semantic pass is the primary defense. Rule set versioned and updatable. |
| Obfuscated injection (zero-width chars, multilingual, leetspeak) | Accepted. Explicitly outside syntactic filter scope. Semantic pass handles these.                                                    |
| False positives on legitimate educational/quoted content         | Accepted. Flags proceed to semantic pass. Hard blocks limited to unambiguous patterns.                                               |
| Syntactic filter itself targeted by obfuscation                  | Mitigated by semantic pass as final arbiter. Syntactic filter is not the security boundary.                                          |
| Two-pass hard block skips semantic pass on edge cases            | Mitigated by conservative hardBlockRules default and frequency tracking override.                                                    |
| Strict transcript allowlist requires maintenance                 | Accepted. CI enforcement recommended. Security benefit outweighs maintenance cost.                                                   |
| Frequency decay scoring has tunable thresholds                   | Mitigated by conservative defaults. Operator-configurable for environment-specific needs.                                            |

---

## Out of Scope

- Real-time rule set updates without restart
- ML-based syntactic classification (rule-based only in this spec)
- Cross-session pattern correlation (see future work in audit-alerting-spec)
- Network-based threat intelligence feeds
- Syntactic validation of MCP server manifests or tool definitions
- Alerting and notification delivery (see companion spec: audit-alerting-spec.md)
