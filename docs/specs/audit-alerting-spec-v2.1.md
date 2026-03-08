# Audit Alerting

### OpenClaw · Feature Spec · v2.3

### Companion to: Input Validation Layers v2.3, Audit Trail Enhancement v2.2

---

## Changelog (v2.2 → v2.3)

| Issue                                                                                                                                               | Resolution                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-Session Event Index stated the index "is rebuilt on process restart by tailing recent JSONL files" — no such rebuild logic exists in state.ts | Corrected: the index starts empty on restart. A brief gap in cross-session alerting after restart is an accepted tradeoff. Rebuild is not implemented. |

## Changelog (v2.1 → v2.2)

| Issue                                                                                          | Resolution                                                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `sessionId: null` for cross-session alerts not implemented; code always uses `entry.sessionId` | Updated `AlertPayload` type and rule descriptions to reflect actual behavior.                                   |
| `suppressedCount` described as incremented on dedup; code never tracks or sets it              | Updated dedup section and payload type comment to reflect that `suppressedCount` is reserved but not populated. |
| Rate-limit meta-alerts (`_system.rateLimitActive`, `_system.rateLimitCleared`) not implemented | Marked as not yet implemented. Rate-limited alerts are silently dropped with a warning log.                     |
| Daily summary described as written to `daily/<YYYY-MM-DD>.json`; only in-memory counts exist   | Updated Daily Summary section to reflect in-memory-only behavior. File write is deferred.                       |
| Webhook no-secret described as omitting `X-OpenClaw-Signature`; code sends `sha256=unsigned`   | Updated Webhook Signing and Config Reference to document actual behavior.                                       |

## Changelog (v2 → v2.1)

| Issue                                 | Resolution                                             |
| ------------------------------------- | ------------------------------------------------------ |
| Spec referenced companion specs at v2 | Updated references to v2.1 for cross-spec consistency. |

## Changelog (v1 → v2)

| Issue                                                                                           | Resolution                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule 5 duplicated Rule 3 tier3 trigger, producing double critical alerts                        | Rule 5 removed as independent rule. Its "cannot be disabled" constraint is now a modifier on Rule 3's tier3 handling.                                 |
| Webhook delivery had no authentication — receivers could not verify alert origin                | Added HMAC-SHA256 webhook signing with `X-OpenClaw-Signature` header.                                                                                 |
| Rule 4 correlation between `sanitized_block` and `syntactic_pass` had no defined join mechanism | Defined: correlation uses `messageId`. The validation pipeline must emit a `syntactic_pass` audit event (at all verbosity tiers) to enable this join. |
| `recentContext` array in AlertPayload was unbounded                                             | Capped at configurable `N` (default 20). Documented relationship to session suspicion score.                                                          |
| Alert log retention unspecified — files grow forever                                            | Added 30-day default retention matching audit trail spec.                                                                                             |
| Daily summary "midnight (agent-local time)" was undefined                                       | Daily summary fires at midnight UTC.                                                                                                                  |
| Cross-session alert rules (Rule 1, Rule 6) had no mechanism for querying across session files   | Defined: alerting layer maintains an in-memory event index with configurable TTL.                                                                     |
| Rate limit meta-alert could only reach the log channel since webhooks were paused               | Meta-alerts are exempt from rate limiting. Rate limit activation is delivered immediately to all configured channels.                                 |
| `file` channel default path collided with alert log storage path                                | Clarified: they are the same file serving both purposes. The `file` channel writes to the alert log.                                                  |

---

## Summary

Define the alerting and monitoring layer that consumes audit events produced
by the input validation pipeline and session memory system. This spec covers
what signals are actionable, when they trigger alerts, who receives them, and
how escalation works. It does not redefine the audit events themselves — those
are specified in the input validation layers spec and the audit trail spec.

---

## Design Goals

- **Actionable, not noisy.** Alerts fire on patterns that require operator
  attention, not on every individual flag. Single syntactic flags are not
  alerts — sustained patterns are.
- **Tiered severity.** Not all events are equal. A schema violation on an
  untrusted MCP tool is different from a session termination due to repeated
  injection attempts.
- **Operator-configurable.** Thresholds, delivery channels, and suppression
  rules are all configurable. Defaults are conservative.
- **Decoupled from validation.** The alerting layer reads the audit log. It
  does not modify validation behavior. Validation writes events; alerting
  reads and acts on them.
- **Fully toggleable.** The entire alerting layer is a toggle. When disabled,
  no alerting I/O occurs. When enabled, individual rules can be toggled
  independently (with one exception: tier3 session termination alerts cannot
  be disabled).

---

## Signal Sources

The alerting layer consumes events from the per-session audit JSONL at:

```
~/.openclaw/agents/<agentId>/session-memory/audit/<sessionId>.jsonl
```

### Cross-Session Event Index

Alert rules that aggregate across sessions (Rule 1, Rule 6) require querying
events from multiple session files. The alerting layer maintains an in-memory
event index to support this.

The index stores lightweight event references (event type, agentId, sessionId,
timestamp) — not full event payloads. Events are indexed on ingestion and
expire from the index after a configurable TTL.

```
alerting.index.ttlMinutes: number
  Default: 60
  How long events remain in the in-memory index. Must be >= the largest
  aggregation window configured on any rule (e.g., Rule 1's windowMinutes).
```

As log volume grows, the index can be extended with hierarchical bucketing
(per-minute buckets rolled into per-hour buckets) to maintain O(1) insertion
and bounded memory. For the initial implementation, a flat ring buffer per
event type is sufficient for the expected event volumes.

The index is ephemeral — it starts empty on process restart with no rebuild
from disk. This means a brief gap in cross-session alerting occurs after each
restart, which is an accepted tradeoff for simplicity. (A rebuild-on-restart
path that tails recent JSONL files is deferred to a future release.)

### Events consumed from Input Validation Layers spec

| Event                        | Severity | Description                                                                   |
| ---------------------------- | -------- | ----------------------------------------------------------------------------- |
| `syntactic_fail`             | low      | Known injection pattern matched in syntactic filter.                          |
| `syntactic_pass`             | info     | Input passed syntactic filter with no flags. Required for Rule 4 correlation. |
| `syntactic_flags`            | info     | Suspicious but non-definitive pattern detected.                               |
| `schema_fail`                | medium   | Input structurally invalid for its source type.                               |
| `twopass_hard_block`         | medium   | Semantic pass skipped; hard block rule triggered.                             |
| `frequency_escalation_tier1` | medium   | Session suspicion score crossed tier 1.                                       |
| `frequency_escalation_tier2` | high     | Session suspicion score crossed tier 2.                                       |
| `frequency_escalation_tier3` | critical | Session terminated due to sustained suspicious input.                         |

> **Important:** `syntactic_pass` must be emitted as an audit event at all
> verbosity tiers when the alerting layer is enabled, even if the audit trail
> spec would otherwise suppress it (e.g., at `minimal` verbosity). This is
> because Rule 4 requires correlating `sanitized_block` events with a prior
> `syntactic_pass` on the same `messageId`. If alerting is disabled, the
> audit trail spec's verbosity rules govern `syntactic_pass` emission normally.

### Events consumed from existing session memory system

| Event             | Severity | Description                                              |
| ----------------- | -------- | -------------------------------------------------------- |
| `sanitized_block` | medium   | Semantic sub-agent judged content unsafe.                |
| `write_failed`    | low      | Session memory write failed (may indicate system issue). |

### Severity levels

| Level      | Meaning                         | Default behavior                                                                                             |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `info`     | Logged, no alert                | Available in dashboards and log queries.                                                                     |
| `low`      | Logged, alert on aggregation    | Alert only if count exceeds threshold within window.                                                         |
| `medium`   | Alert on occurrence             | Single occurrence triggers alert delivery.                                                                   |
| `high`     | Alert immediately with context  | Immediate delivery with session details and recent event history.                                            |
| `critical` | Alert immediately, page on-call | Immediate delivery to all configured channels including paging. Cannot be disabled (Rule 3, tier3 modifier). |

---

## Alert Rules

### Rule 1: Repeated syntactic failures (aggregation alert)

- **Trigger:** ≥ `N` `syntactic_fail` events across any sessions for the
  same agent within `W` minutes
- **Default:** N = 5, W = 10
- **Severity:** medium
- **Rationale:** A single syntactic failure is expected noise. Multiple
  failures in a short window across sessions may indicate a coordinated
  probing attempt.
- **Cross-session mechanism:** Uses the in-memory event index to count
  `syntactic_fail` events across all sessions for the agent within the
  window. Index TTL must be >= `W`.
- **Config:**
  ```
  alerting.rules.syntacticFailBurst.count: number (default: 5)
  alerting.rules.syntacticFailBurst.windowMinutes: number (default: 10)
  ```

### Rule 2: Schema violation on trusted MCP tool

- **Trigger:** `schema_fail` event where the originating MCP tool has trust
  tier ≥ `trusted`
- **Severity:** high
- **Rationale:** A trusted tool producing structurally invalid output
  suggests either tool compromise, API contract change, or a supply-chain
  issue. This should not happen under normal operation.
- **Config:**
  ```
  alerting.rules.trustedToolSchemaFail.enabled: boolean (default: true)
  ```

### Rule 3: Frequency escalation tier 2+ (with session termination modifier)

- **Trigger:** `frequency_escalation_tier2` or `frequency_escalation_tier3`
  event
- **Severity:** high (tier 2), critical (tier 3)
- **Rationale:** Tier 2+ means sustained injection activity within a single
  session. Operator should investigate whether the session source is
  compromised.
- **Session termination modifier (tier 3):** When this rule fires at tier 3,
  it indicates a session was forcibly terminated — the most severe automated
  response. The tier 3 handling **cannot be disabled**. This is the only
  non-disablable alert in the system.
- **Config:**
  ```
  alerting.rules.frequencyEscalation.tier2.enabled: boolean (default: true)
  alerting.rules.frequencyEscalation.tier3.enabled: boolean (always true, read-only)
  ```

> **Why a modifier instead of a separate rule:** The previous spec had a
> standalone "Rule 5: Session termination" that triggered on the same
> `frequency_escalation_tier3` event as Rule 3. Because deduplication keys
> on `ruleId + agentId + sessionId`, two rules with different ruleIds firing
> on the same event would produce duplicate critical alerts for every session
> termination. Merging them eliminates the double-fire while preserving the
> "cannot be disabled" semantic.

### Rule 4: Semantic block after syntactic pass

- **Trigger:** `sanitized_block` event for an input whose corresponding
  `syntactic_pass` event (matched by `messageId`) had no flags
- **Severity:** medium
- **Rationale:** The semantic sub-agent caught something the syntactic filter
  missed entirely. This is the system working as designed (defense in depth),
  but repeated occurrences may indicate a new attack pattern that should be
  added to the syntactic rule set.
- **Correlation mechanism:** The alerting layer joins `sanitized_block` and
  `syntactic_pass` events by `messageId`. Both events must include a
  `messageId` field for this join to succeed. If `messageId` is null on
  either event (e.g., for tool call inputs), the join falls back to
  `toolCallId`. If both are null, the correlation is skipped and a warning
  is logged.
- **Config:**
  ```
  alerting.rules.semanticCatchNoSyntacticFlag.enabled: boolean (default: true)
  alerting.rules.semanticCatchNoSyntacticFlag.escalateAfter: number (default: 3)
  ```
  After `escalateAfter` occurrences within 24 hours, severity escalates to
  `high` to prompt rule set review.

### Rule 5: Write failure spike

- **Trigger:** ≥ `N` `write_failed` events for the same agent within `W`
  minutes
- **Default:** N = 3, W = 5
- **Severity:** medium
- **Rationale:** Repeated write failures may indicate storage issues, disk
  pressure, or a bug in the write path — not necessarily a security issue,
  but an operational one.
- **Cross-session mechanism:** Uses the in-memory event index, same as Rule 1.
- **Config:**
  ```
  alerting.rules.writeFailSpike.count: number (default: 3)
  alerting.rules.writeFailSpike.windowMinutes: number (default: 5)
  ```

---

## Alert Payload

All alerts share a common payload structure:

```typescript
type AlertPayload = {
  alertId: string; // unique identifier for deduplication
  ruleId: string; // which rule fired (e.g., "syntacticFailBurst")
  severity: "info" | "low" | "medium" | "high" | "critical";
  agentId: string;
  sessionId: string; // the triggering event's sessionId (cross-session aggregation rules still use the triggering event's id)
  timestamp: string; // ISO 8601
  summary: string; // human-readable one-line description
  details: {
    triggeringEvents: AuditEvent[]; // the event(s) that caused the alert
    recentContext: AuditEvent[]; // last N events from same session (capped)
    sessionSuspicionScore?: number; // current exponential decay score if applicable
  };
  metadata: {
    ruleConfig: Record<string, unknown>; // the config values that governed this rule
    suppressedCount?: number; // reserved; not currently populated
  };
};
```

### `recentContext` cap

The `recentContext` array is capped at `N` most recent events from the same
session. This prevents payload bloat at high verbosity tiers where sessions
may generate dozens of events per turn.

```
alerting.payload.recentContextMax: number (default: 20)
```

### `sessionSuspicionScore`

When present, this is the current exponential decay score for the session's
frequency tracking. The score is computed as:

```
currentScore = previousScore × e^(-elapsed / halfLife) + newFlagWeight
```

This is the same score used by the frequency escalation tiers in the input
validation spec. It provides a single floating-point number representing how
suspicious the session currently is, factoring in both recency and severity
of flags.

---

## Delivery Channels

Alerts are delivered to one or more configured channels based on severity.

### Channel types

| Channel   | Use case                                                    | Config key                          |
| --------- | ----------------------------------------------------------- | ----------------------------------- |
| `log`     | All severities. Always enabled. Writes to alert log file.   | `alerting.channels.log` (always on) |
| `webhook` | Medium+ alerts to external systems (Slack, PagerDuty, etc.) | `alerting.channels.webhook.url`     |

> **Note on `file` channel:** The previous spec listed `file` as a separate
> channel type. The `log` channel already writes structured `AlertPayload`
> JSON to `alerts.jsonl`, which serves the same purpose. There is no separate
> `file` channel — the alert log is the structured file output for external
> consumption.

### Severity-to-channel defaults

| Severity | log | webhook |
| -------- | --- | ------- |
| info     | yes | no      |
| low      | yes | no      |
| medium   | yes | yes     |
| high     | yes | yes     |
| critical | yes | yes     |

### Webhook format

POST request with `AlertPayload` as JSON body. Includes:

- `X-OpenClaw-Alert-Severity` header for filtering at the receiver
- `X-OpenClaw-Signature` header for payload authentication (see Webhook Signing)
- `X-OpenClaw-Timestamp` header with ISO 8601 timestamp of the request

Webhook delivery is fire-and-forget with configurable retry:

```
alerting.channels.webhook.retries: number (default: 2)
alerting.channels.webhook.retryDelayMs: number (default: 1000)
alerting.channels.webhook.timeoutMs: number (default: 5000)
```

Failed webhook deliveries are logged but do not block the validation
pipeline or affect alert state.

### Webhook Signing

All webhook requests are signed to allow receivers to verify that alerts
originate from OpenClaw and have not been tampered with in transit.

**Signing method:** HMAC-SHA256

**Signature computation:**

```
signature = HMAC-SHA256(
  key: webhookSecret,
  message: timestamp + "." + requestBody
)
```

Where:

- `webhookSecret` is the configured shared secret
- `timestamp` is the value of the `X-OpenClaw-Timestamp` header
- `requestBody` is the raw JSON body (not parsed/re-serialized)

**Header format:**

```
X-OpenClaw-Signature: sha256=<hex-encoded signature>
```

**Receiver verification:**

1. Extract the `X-OpenClaw-Timestamp` header
2. Reject if timestamp is more than 5 minutes old (prevents replay attacks)
3. Compute expected signature over `timestamp + "." + rawBody`
4. Compare using constant-time comparison to prevent timing attacks

**Config:**

```
alerting.channels.webhook.secret: string | null
  Default: null
  Shared secret for HMAC-SHA256 webhook signing. Stored in the standard
  OpenClaw secrets directory at:
    ~/.openclaw/secrets/alerting/webhook.secret
  When null, webhook signing is disabled. The `X-OpenClaw-Signature` header
  is still sent with value `sha256=unsigned` so receivers can detect unsigned
  requests. A warning is logged at startup if a webhook URL is configured
  but no signing secret is set.
```

> **Security recommendation:** Always configure a webhook signing secret in
> production. Without it, any party that discovers the webhook URL can inject
> fake alerts — including fake "all clear" signals that could mask real
> incidents. The signing secret should be a high-entropy random string
> (minimum 32 bytes).

---

## Deduplication and Suppression

### Deduplication

Alerts with the same `ruleId` + `agentId` + `sessionId` within a
configurable suppression window are deduplicated. Only the first alert in
the window is delivered; subsequent duplicates are silently skipped.

```
alerting.suppression.windowMinutes: number (default: 5)
```

### Rate limiting

Global alert rate limit to prevent alert storms:

```
alerting.rateLimit.maxPerMinute: number (default: 20)
alerting.rateLimit.maxPerHour: number (default: 100)
```

When rate limited, alerts that exceed the limit are silently dropped with a
warning log entry. They are not written to `alerts.jsonl` and not delivered
to webhook channels.

> **Not yet implemented:** Rate limit meta-alerts (`_system.rateLimitActive`,
> `_system.rateLimitCleared`) are not emitted. When the rate limit activates,
> a warning is logged but no meta-alert is sent to any channel.

---

## Alert Log Storage

Alert records are stored separately from session audit logs at:

```
~/.openclaw/agents/<agentId>/alerts/alerts.jsonl
```

Each line is a JSON-serialized `AlertPayload`. This file is append-only
and can be rotated by standard log rotation tools.

### Retention

Alert log files follow a configurable retention period:

```
alerting.retention.days: number (default: 30)
```

Cleanup runs on the same schedule as audit trail cleanup. Files older than
`retentionDays` are removed.

### Daily Summary

The alerting layer maintains in-memory daily summary counts accessible via
`getDailySummary()`. The summary includes total alert count by severity and
top triggered rules for the current process lifetime.

> **Not yet implemented:** Daily summary files are not written to disk.
> The `daily/<YYYY-MM-DD>.json` path is not created. In-memory counts reset
> on process restart. Persistent daily summaries are deferred to a future release.

---

## Future Work (Out of Scope)

- **Cross-session pattern correlation.** Detect coordinated attacks across
  multiple sessions targeting the same agent. Requires session-to-source
  attribution not currently tracked.
- **Dashboard UI.** Visual display of alert history, trends, and active
  sessions. Depends on a frontend that doesn't exist yet.
- **Automated rule set updates.** When Rule 4 (semantic catch without
  syntactic flag) fires repeatedly for the same pattern, automatically
  propose a new syntactic rule. Requires pattern extraction from semantic
  sub-agent output. (Note: Rule 4's `escalateAfter` config provides the
  signal that this automation should be prioritized — when operators are
  manually reviewing the same class of alert repeatedly, it's time to
  automate.)
- **External threat intelligence.** Ingest known-bad patterns from external
  feeds to augment the syntactic rule set.
- **Alert acknowledgment workflow.** Allow operators to acknowledge, snooze,
  or resolve alerts with tracking.
- **Hierarchical index bucketing.** As event volume grows, the flat ring
  buffer in the cross-session event index can be replaced with per-minute
  buckets rolled into per-hour buckets for bounded memory. Deferred until
  event volume justifies the complexity.

---

## Config Reference

Full config namespace: `alerting.*`

```
alerting.enabled: boolean
  Default: true
  Master switch for the alerting layer. When false, no alerting I/O occurs.

alerting.channels.webhook.url: string | null
  Default: null
  Webhook endpoint for alert delivery. Null disables webhook channel.

alerting.channels.webhook.secret: string | null
  Default: null
  Shared secret for HMAC-SHA256 webhook signing. Stored in:
    ~/.openclaw/secrets/alerting/webhook.secret
  When null, X-OpenClaw-Signature is sent as "sha256=unsigned".
  Warning logged at startup if webhook URL is set but secret is null.

alerting.channels.webhook.retries: number
  Default: 2

alerting.channels.webhook.retryDelayMs: number
  Default: 1000

alerting.channels.webhook.timeoutMs: number
  Default: 5000

alerting.suppression.windowMinutes: number
  Default: 5

alerting.rateLimit.maxPerMinute: number
  Default: 20

alerting.rateLimit.maxPerHour: number
  Default: 100

alerting.retention.days: number
  Default: 30
  Retention for alert log files.

alerting.payload.recentContextMax: number
  Default: 20
  Maximum number of recent events included in alert payload context.

alerting.index.ttlMinutes: number
  Default: 60
  TTL for events in the in-memory cross-session index. Must be >= the
  largest aggregation window configured on any rule.

alerting.rules.syntacticFailBurst.count: number
  Default: 5

alerting.rules.syntacticFailBurst.windowMinutes: number
  Default: 10

alerting.rules.trustedToolSchemaFail.enabled: boolean
  Default: true

alerting.rules.frequencyEscalation.tier2.enabled: boolean
  Default: true

alerting.rules.frequencyEscalation.tier3.enabled: boolean
  Default: true
  Read-only. Always true. Session termination alerts cannot be disabled.

alerting.rules.semanticCatchNoSyntacticFlag.enabled: boolean
  Default: true

alerting.rules.semanticCatchNoSyntacticFlag.escalateAfter: number
  Default: 3

alerting.rules.writeFailSpike.count: number
  Default: 3

alerting.rules.writeFailSpike.windowMinutes: number
  Default: 5
```
