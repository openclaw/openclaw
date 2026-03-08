# Audit Trail Enhancement

### OpenClaw · Feature Spec · v2.2

### Extension of: Transcript Sanitization Subagent for Session Memory + MCP Trust Tier

### Codename: IRS Edition

---

## Changelog (v2.1 → v2.2)

| Issue                                                                                                                         | Resolution                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal_failed` listed as "never implemented" in v1→v2 changelog; event IS implemented in the signal helper path (service.ts) | Re-added to spec. `signal_failed` emits at `minimal` verbosity via `gatedAudit`, including alerting notification. Added to Current State and minimal tier event list. |

## Changelog (v2 → v2.1)

| Issue                                                                                                                | Resolution                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Input validation events (`syntactic_fail`, `schema_fail`, `frequency_escalation_*`) had no verbosity tier assignment | Assigned: security-relevant events to `minimal`, pass events and flags to `standard`.                     |
| `syntactic_pass` emission at `minimal` verbosity conflicted with alerting spec Rule 4 requirement                    | Added alerting override note: `syntactic_pass` emitted at all tiers when alerting is enabled.             |
| `rule_triggered` fan-out from validation `ruleIds[]` arrays had no assigned owner                                    | Defined: audit subsystem performs the fan-out from validation results to per-rule events.                 |
| `flags_summary` granularity (per-stage vs per-turn) was ambiguous given parallel execution                           | Clarified: one `flags_summary` per stage that produced flags.                                             |
| `scope-creep.unexpected-field` and `schema.extra-field` described the same condition                                 | Consolidated under `schema.extra-field`. `scope-creep` category now limited to intent-based rules.        |
| Rule taxonomy did not indicate which stage detects each rule                                                         | Added Detection Stage column. Documented that `semantic`-stage rules must be configured in the sub-agent. |

## Changelog (v1 → v2)

| Issue                                                                            | Resolution                                                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `signal_failed` listed in current state but absent from all verbosity tiers      | Removed at v2 as believed unimplemented. Re-added at v2.2 — event IS implemented; see v2.1→v2.2 changelog.        |
| `flags_summary` redundant at `high`+ verbosity alongside `rule_triggered` events | `flags_summary` is now suppressed when `rule_triggered` events are emitted. See Verbosity Tiers.                  |
| `audit_config_loaded` behavior when `audit.enabled: false` was ambiguous         | Clarified. When `audit.enabled: false`, no events are written, no I/O occurs. The audit subsystem is fully inert. |
| Unknown ruleId startup behavior unspecified                                      | Clarified as warning log.                                                                                         |
| `output_diff` tradeoff between `high` and `maximum` not documented for operators | Added explicit operator note.                                                                                     |
| Encryption keystore path undefined                                               | Defined. Uses the standard OpenClaw secrets directory.                                                            |
| Out of Scope listed "real-time alerting" which now exists as a companion spec    | Updated to reference the alerting spec.                                                                           |

---

## Summary

Extend the existing session sanitization audit log to record the original input,
sanitized output, and the rule or signal that triggered each sanitization action.
Add configurable verbosity tiers so operators can tune between minimal logging
(performance/privacy-sensitive deployments) and maximum logging (compliance
deployments). All three enhancements from the feedback are implemented: input/output
diff recording, rule tagging in flags, and structured per-rule audit events.

---

## Design Goals

- **Compliance-ready.** Maximum verbosity mode produces a complete, machine-queryable
  record of every sanitization decision, suitable for regulatory audit.
- **Privacy-respecting by default.** Default verbosity does not store raw input.
  Operators opt into input storage explicitly, with awareness of the privacy tradeoff.
- **Machine-queryable.** Rule identifiers are structured codes, not free-text
  descriptions. Audit log consumers can filter, aggregate, and alert on specific
  rule triggers without parsing prose.
- **Non-blocking.** Audit writes remain fire-and-forget on the transcript path.
  Enhanced audit entries add no latency to interactive replies.
- **Toggleable.** Audit verbosity is a config field. Operators can disable
  specific event types or reduce verbosity without disabling sanitization.
- **Fully inert when disabled.** When `audit.enabled: false`, the audit subsystem
  performs no I/O, writes no events, and adds no overhead. Sanitization itself
  still runs — only the audit trail is disabled.

---

## Current State

The existing audit log records:

```
event: "sanitized_pass" | "sanitized_block" | "write_failed" | "signal_failed"
messageId or toolCallId
timestamp
sessionId
agentId
```

> **Note:** `signal_failed` was previously removed from this spec (v1→v2) as
> believed unimplemented. It is re-added at v2.2. The event fires when the
> signal helper sub-agent throws (service.ts `signalSessionMemory` catch block),
> is emitted via `gatedAudit` at `minimal` verbosity with alerting notification,
> and is listed in `EVENT_MIN_VERBOSITY`. If
> should be defined with clear semantics and assigned to a verbosity tier.

What the existing log does not record:

- The original input content
- The sanitized output content
- Which specific rule or signal caused a block or flag
- A diff between input and output
- Per-rule events (one entry per triggered rule vs one entry per turn)

---

## Verbosity Tiers

Four tiers, operator-configurable. Higher tiers include all events from lower tiers,
with one exception noted below.

### `minimal`

Records only terminal outcomes and security-relevant events. Suitable for
production deployments where audit is required but storage and privacy
constraints are tight.

Events recorded:

- `sanitized_block` — content was blocked
- `write_failed` — sanitization write failed
- `signal_failed` — signal helper sub-agent threw; session signal degraded gracefully
- `twopass_hard_block` — content blocked at syntactic stage (from input validation spec)
- `syntactic_fail` — known injection pattern matched (from input validation spec)
- `schema_fail` — input structurally invalid (from input validation spec)
- `frequency_escalation_tier1` — session suspicion crossed tier 1 (from input validation spec)
- `frequency_escalation_tier2` — session suspicion crossed tier 2 (from input validation spec)
- `frequency_escalation_tier3` — session terminated (from input validation spec)
- `context_profile_loaded` — active context profile recorded at session start (from context-aware sanitization spec)

Events omitted:

- `sanitized_pass` — clean passes are not recorded
- `syntactic_pass`, `schema_pass` — clean pre-filter passes are not recorded
- `syntactic_flags` — non-definitive flags are not recorded
- Per-rule detail events

> **Alerting override:** When the alerting layer is enabled, `syntactic_pass`
> is emitted regardless of verbosity tier. This is required for Alert Rule 4
> correlation (joining `sanitized_block` with prior `syntactic_pass` by
> `messageId`). See audit-alerting-spec, Signal Sources. When alerting is
> disabled, `syntactic_pass` emission follows the verbosity rules above.

### `standard` (default)

Adds pass events and flag summaries. Suitable for most deployments.

Events recorded (all `minimal` events plus):

- `sanitized_pass` — clean passes recorded with confidence tier
- `syntactic_pass` — input passed syntactic filter with no flags
- `schema_pass` — input passed schema validation
- `syntactic_flags` — non-definitive flags detected (rule IDs only, no content)
- `flags_summary` — summary of flags raised per stage (rule IDs only, no content).
  One `flags_summary` event per stage that produced flags (not one aggregate per turn).

### `high`

Adds per-rule structured events and output diff. Suitable for security-sensitive
deployments and incident investigation.

Events recorded (all `standard` events plus):

- `rule_triggered` — one event per triggered rule, with rule ID and location hint
- `output_diff` — structured diff between input and sanitized output
  (what was removed or replaced, not the raw content itself)

**Exception:** `flags_summary` is suppressed at `high` and above. The individual
`rule_triggered` events provide strictly more information. Consumers that need a
rollup view should aggregate `rule_triggered` events by `messageId`/`toolCallId`.

> **Operator note:** The `output_diff` event at `high` tier records hashes and
> character counts of removed/replaced content, but not the content itself. This
> is sufficient for correlation and pattern detection. For actual incident
> investigation where you need to see the raw content that was removed, you need
> `maximum` verbosity. Plan your verbosity tier based on your incident response
> requirements, not just your steady-state needs.

### `maximum`

Adds raw input storage. Suitable for compliance deployments where full
evidentiary record is required. **Privacy warning: raw user messages and
tool results are written to disk.**

Events recorded (all `high` events plus):

- `raw_input_captured` — full original input, encrypted at rest
- `raw_output_captured` — full sanitized output

> **I/O budget warning:** At `maximum` verbosity with the alerting layer enabled,
> each turn may produce: audit JSONL entries, per-rule `rule_triggered` events,
> `output_diff`, encrypted input/output sidecars, alert JSONL entries, and
> webhook calls. Use `maximum` only on deployments with adequate I/O headroom.
> All writes are queued and non-blocking, but cumulative disk throughput should
> be monitored.

---

## New Event Types

### `flags_summary` (standard only)

Emitted at `standard` verbosity. Suppressed at `high` and above where
`rule_triggered` events provide per-rule detail.

One `flags_summary` event is emitted per stage that produced flags for a given
turn. If only the syntactic filter flags, one event with `stage: "syntactic"`.
If both syntactic and schema flag on the same input, two events. This is
consistent with the parallel execution model in the input validation spec.

```typescript
{
  event: "flags_summary",
  messageId?: string,
  toolCallId?: string,
  sessionId: string,
  agentId: string,
  timestamp: string,
  profile: string,           // active context profile
  ruleIds: string[],         // machine-readable rule identifiers
  flagCount: number,
  blocked: boolean,          // whether any flag resulted in a block
  stage: "syntactic" | "schema" | "semantic"
}
```

### `rule_triggered` (high+)

One event per triggered rule. Enables per-rule filtering and alerting.

**Fan-out responsibility:** The audit subsystem is responsible for expanding
validation results into individual `rule_triggered` events. The input validation
pipeline returns `ruleIds: string[]` arrays in its results; the audit subsystem
fans these out into one `rule_triggered` event per rule ID, populating
`ruleCategory` from the rule taxonomy and `stage` from the validation result's
origin. This keeps the validation pipeline focused on pass/fail decisions and
the audit layer focused on recording them.

```typescript
{
  event: "rule_triggered",
  messageId?: string,
  toolCallId?: string,
  sessionId: string,
  agentId: string,
  timestamp: string,
  profile: string,
  ruleId: string,            // e.g. "injection.ignore-previous"
  ruleCategory: string,      // e.g. "injection" | "scope-creep" | "credential" | "structural"
  severity: "block" | "flag",
  locationHint?: string,     // e.g. "messages[2].content" — where in the payload
  stage: "syntactic" | "schema" | "semantic"
}
```

### `output_diff` (high+)

Records what changed between input and sanitized output without storing
full raw content.

```typescript
{
  event: "output_diff",
  messageId?: string,
  toolCallId?: string,
  sessionId: string,
  agentId: string,
  timestamp: string,
  profile: string,
  removals: Array<{
    location: string,        // JSON path e.g. "messages[2].content"
    reason: string,          // ruleId that caused removal
    lengthBefore: number,    // character count of removed content
    sha256: string,          // hash of removed content (for dedup/correlation)
  }>,
  replacements: Array<{
    location: string,
    reason: string,
    lengthBefore: number,
    lengthAfter: number,
    sha256Before: string,
  }>
}
```

### `raw_input_captured` (maximum only)

```typescript
{
  event: "raw_input_captured",
  messageId?: string,
  toolCallId?: string,
  sessionId: string,
  agentId: string,
  timestamp: string,
  encryptionKeyId: string,   // identifies which key was used
  payloadPath: string,       // path to encrypted file on disk
  payloadSha256: string,     // hash of plaintext before encryption
  payloadBytes: number
}
```

Raw input is written to a separate encrypted sidecar, not inline in the JSONL.
The audit entry records a pointer to the file, not the content itself.

### `raw_output_captured` (maximum only)

Same shape as `raw_input_captured`. Points to the sanitized output sidecar.

### `audit_config_loaded` (all tiers, when audit is enabled)

Recorded at session start alongside `context_profile_loaded`. This event is
only emitted when `audit.enabled: true`. When audit is disabled, no events
of any kind are written — the subsystem is fully inert.

```typescript
{
  event: "audit_config_loaded",
  sessionId: string,
  agentId: string,
  timestamp: string,
  verbosity: "minimal" | "standard" | "high" | "maximum",
  rawInputEnabled: boolean,    // true only in maximum
  encryptionEnabled: boolean,
  retentionDays: number
}
```

---

## Rule ID Taxonomy

Rule identifiers follow a `category.subcategory` pattern. Machine-readable,
stable across versions.

At startup, the system validates all registered rule IDs against the taxonomy.
Any rule ID not present in the taxonomy produces a **warning log** with the
unrecognized ID. The system continues to operate — unknown rule IDs are not
a fatal error — but the warning ensures operators notice configuration drift
or missing taxonomy entries.

| Category      | Subcategory              | Description                                        | Detection Stage |
| ------------- | ------------------------ | -------------------------------------------------- | --------------- |
| `injection`   | `ignore-previous`        | "ignore previous instructions" variants            | syntactic       |
| `injection`   | `system-override`        | "SYSTEM:" / system override phrases                | syntactic       |
| `injection`   | `role-switch-capability` | role-switch + capability-grant combo               | syntactic       |
| `injection`   | `role-switch-only`       | role-switch phrase without capability grant        | syntactic       |
| `injection`   | `direct-address`         | content addressing the agent directly              | semantic        |
| `credential`  | `api-key-pattern`        | API key shaped content                             | semantic        |
| `credential`  | `password-pattern`       | password field or assignment pattern               | semantic        |
| `credential`  | `env-var-pattern`        | environment variable assignment                    | semantic        |
| `scope-creep` | `permission-escalation`  | content requesting elevated permissions            | semantic        |
| `scope-creep` | `cross-agent-reference`  | reference to another agent's data                  | semantic        |
| `structural`  | `oversized-payload`      | payload exceeds size limit                         | syntactic       |
| `structural`  | `excessive-depth`        | JSON nesting exceeds depth limit                   | syntactic       |
| `structural`  | `encoding-trick`         | base64 or homoglyph obfuscation                    | syntactic       |
| `structural`  | `binary-content`         | non-UTF8 content in text field                     | syntactic       |
| `schema`      | `missing-field`          | required field absent                              | schema          |
| `schema`      | `type-mismatch`          | field type does not match declared type            | schema          |
| `schema`      | `extra-field`            | unexpected top-level field or undeclared MCP field | schema          |
| `semantic`    | `safe-false`             | sub-agent returned safe: false                     | semantic        |
| `semantic`    | `low-confidence`         | sub-agent confidence below threshold               | semantic        |
| `semantic`    | `malformed-output`       | sub-agent output failed schema validation          | semantic        |

> **Resolved duplicate:** The previous taxonomy listed both
> `scope-creep.unexpected-field` and `schema.extra-field` for the same
> condition (undeclared fields on MCP results or transcript payloads). These
> are consolidated under `schema.extra-field`. The schema validator detects
> the structural violation; the semantic sub-agent handles scope-creep
> patterns that require intent analysis (`permission-escalation`,
> `cross-agent-reference`).
>
> **Detection stage note:** Rules marked `semantic` are detected by the
> semantic sub-agent (Stage 2 in the input validation spec). The sub-agent
> must be configured to return these rule IDs in its output. Rules marked
> `syntactic` or `schema` are detected by the corresponding pre-filter
> (Stage 1A or 1B).

---

## Raw Input Encryption (maximum tier)

Raw input is never written to disk in plaintext.

Encryption approach:

- AES-256-GCM
- Per-session key generated at session start
- Key stored in the standard OpenClaw secrets directory at:
  ```
  ~/.openclaw/secrets/agents/<agentId>/audit-keys/<sessionId>.key
  ```
  This follows the same access control model as other OpenClaw secrets
  (API keys, MCP credentials, etc.). The secrets directory should have
  restrictive filesystem permissions (0700 owner-only).
- `encryptionKeyId` in audit entry references the key, not the key itself
- Encrypted files stored at:
  ```
  ~/.openclaw/agents/<agentId>/session-memory/raw-audit/<sessionId>/<messageId>-input.enc
  ~/.openclaw/agents/<agentId>/session-memory/raw-audit/<sessionId>/<messageId>-output.enc
  ```

Key rotation: keys rotate per session. Previous session keys are retained for
the configured `retentionDays` period to allow decryption of archived audit
entries. Expired keys are cleaned up alongside their session's audit files.

---

## Retention and Cleanup

Audit JSONL files follow the same retention as session memory sidecars:
configurable `retentionDays`, cleaned up on session reset/delete.

Raw encrypted sidecars (`maximum` tier) follow the same retention but have
a separate config field to allow longer retention for compliance:

```
memory.sessions.sanitization.audit.rawRetentionDays: number
  Default: same as retentionDays
  Separate control for encrypted raw input/output files.
```

Cleanup of raw sidecars fires on the same hooks as regular sidecar cleanup
(session reset, session delete, `initSessionState` rotation) per the session
sidecar cleanup fix already in the PR.

Encryption keys in the secrets directory are cleaned up on the same schedule
as their corresponding raw audit sidecars (governed by `rawRetentionDays`).

---

## Config Surface

```
memory.sessions.sanitization.audit.verbosity:
  "minimal" | "standard" | "high" | "maximum"
  Default: "standard"

memory.sessions.sanitization.audit.retentionDays: number
  Default: 30
  Retention for audit JSONL files.

memory.sessions.sanitization.audit.rawRetentionDays: number
  Default: same as retentionDays
  Retention for encrypted raw input/output sidecars (maximum tier only).

memory.sessions.sanitization.audit.enabled: boolean
  Default: true
  Master toggle. When false, no audit events are written, no audit I/O
  occurs, and no audit-related overhead is incurred. Sanitization itself
  still runs — only the audit trail is disabled.
```

---

## Storage Layout (Updated)

```
~/.openclaw/agents/<agentId>/session-memory/
  audit/
    <sessionId>.jsonl           ← existing audit JSONL (all tiers)
  raw-audit/                    ← new, maximum tier only
    <sessionId>/
      <messageId>-input.enc
      <messageId>-output.enc
  summary/                      ← existing
  raw/                          ← existing

~/.openclaw/secrets/agents/<agentId>/
  audit-keys/
    <sessionId>.key             ← AES-256-GCM key, maximum tier only
```

---

## Tests

**Verbosity tiers:**

- `minimal`: only block and fail events written; pass events absent
- `standard`: pass events written with confidence tier; flags_summary present
- `high`: rule_triggered events present, one per rule; output_diff present; flags_summary absent
- `maximum`: raw_input_captured and raw_output_captured events present
- Higher tiers include all lower tier events (except flags_summary suppressed at high+)
- `audit.enabled: false` suppresses all audit writes including `audit_config_loaded`; sanitization still runs; no audit I/O occurs

**Rule taxonomy:**

- Each ruleId appears in correct category
- rule_triggered event contains correct ruleCategory for each ruleId
- Unknown ruleId not present in taxonomy produces a warning log at startup; system continues to operate

**Output diff:**

- Removal entries contain correct location, reason (ruleId), and sha256
- Length fields are character counts of original content
- Diff does not contain raw content text, only metadata

**Raw input encryption (maximum):**

- Written files are not plaintext
- Encrypted file is decryptable with recorded encryptionKeyId
- Key is stored at expected path in secrets directory
- Different sessions use different keys
- Cleanup removes encrypted files alongside JSONL on session reset/delete
- Cleanup removes encryption keys alongside raw audit sidecars

**Retention:**

- Files older than retentionDays are cleaned up on session rotation
- rawRetentionDays respected separately when set
- Encryption keys follow rawRetentionDays, not retentionDays

**Audit config event:**

- `audit_config_loaded` present at session start when `audit.enabled: true`
- `audit_config_loaded` absent when `audit.enabled: false`
- Reflects actual loaded config values

**Integration:**

- Complete chain: injection detected → rule_triggered (ruleId) →
  output_diff (location + sha256) → sanitized_block → all in correct order
- `maximum` chain: same as above plus raw_input_captured → raw_output_captured

---

## Privacy Considerations

| Verbosity  | Raw content on disk | PII risk                                 |
| ---------- | ------------------- | ---------------------------------------- |
| `minimal`  | No                  | Low                                      |
| `standard` | No                  | Low                                      |
| `high`     | No                  | Low (sha256 hashes only)                 |
| `maximum`  | Yes (encrypted)     | High — operator must manage key security |

Operators enabling `maximum` verbosity should:

- Restrict filesystem access to the `raw-audit/` directory
- Restrict filesystem access to the `secrets/` directory (0700 owner-only)
- Implement key rotation policy for long-retention deployments
- Ensure `rawRetentionDays` is consistent with data retention obligations
- Document that raw user messages are stored, in any user-facing privacy policy

---

## Residual Risks (Accepted)

| Risk                                                                | Status                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Audit JSONL itself contains sensitive metadata (ruleIds, locations) | Accepted. JSONL is in agent state directory. Filesystem access controls apply.                                                |
| Raw encrypted files persist beyond session if cleanup hook fails    | Mitigated by multiple cleanup hooks. Residual risk accepted.                                                                  |
| Encryption key compromise exposes maximum-tier raw content          | Accepted. Key management is operator responsibility. Keys are in the standard secrets directory with restrictive permissions. |
| High audit verbosity adds write I/O on busy deployments             | Accepted. Writes are queued and fire-and-forget. Operator can reduce verbosity or disable audit entirely.                     |

---

## Out of Scope

- Audit log forwarding to external SIEM or logging infrastructure
- ~~Real-time alerting on rule triggers~~ → Now covered by companion spec: Audit Alerting
- Audit log signing or tamper-evidence
- Cross-session audit correlation
- User-accessible audit log interface
