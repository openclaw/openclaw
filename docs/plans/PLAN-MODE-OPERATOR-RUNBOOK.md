# Plan Mode — Operator Runbook

Field guide for diagnosing plan-mode incidents in production OpenClaw
gateways. Companion to `docs/concepts/plan-mode.md` (user-facing
documentation) and `docs/plans/PLAN-MODE-ARCHITECTURE.md` (design
reference).

Use this runbook when users report plan-mode misbehavior and you need
to isolate root cause from gateway logs.

---

## Enabling the structured debug log

The plan-mode debug stream is OFF by default (zero perf impact). Turn
it on when investigating:

**Persistent (recommended — survives gateway restarts):**

```bash
openclaw config set agents.defaults.planMode.debug true
openclaw gateway restart
```

**Ad-hoc (current terminal-launched run only):**

```bash
OPENCLAW_DEBUG_PLAN_MODE=1 openclaw gateway run
```

**Stream the log:**

```bash
tail -F ~/.openclaw/logs/gateway.err.log | grep '\[plan-mode/'
```

**Trace a single approval cycle** (C7 follow-up added correlation
fields):

```bash
tail -F ~/.openclaw/logs/gateway.err.log | grep '\[plan-mode/' | grep approvalRunId=<id>
```

---

## Symptom → Fix matrix

### 1. Approval card stays on screen after the user clicks Approve

**Canonical signal:** error code `PLAN_APPROVAL_EXPIRED` in the
sessions-patch response.

**Root cause classes:**

- Session already exited plan mode via `/plan off` or completion.
- Another channel (webchat vs Telegram) resolved the approval first.
- Session compaction dropped the `planMode` state mid-flight.

**Diagnostic:**

```bash
grep 'PLAN_APPROVAL_EXPIRED' ~/.openclaw/logs/gateway.err.log | tail
```

**Fix:** the webchat UI auto-dismisses this code (Control UI wired in
C1). If a legacy client or non-web channel shows the stale card,
refresh the session or run `/plan status` to re-sync. No server-side
fix — the code path is intentional (the approval window genuinely
expired).

---

### 2. Subagent stall blocks plan approval

**Canonical signals:**

- `PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS` (open subagents) — returned
  when the user clicks Approve while subagents spawned during the
  investigation phase are still in flight.
- `PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE` — returned when a
  subagent settled within the last 10 seconds (race window).

**Diagnostic:**

```bash
grep 'approval-gate' ~/.openclaw/logs/gateway.err.log | tail -20
```

**Fix:**

- `BLOCKED_BY_SUBAGENTS`: wait for the listed `openSubagentRunIds` to
  return, then re-approve. Plan mode enforces a concurrency cap of 1
  subagent during the investigation phase. If this fires persistently
  despite no visible subagent activity, check that
  `drainCompletedSubagentFromParents(runId)` is being called on
  crash/timeout paths (R1 of C1).
- `WAITING_FOR_SUBAGENT_SETTLE`: wait 10 seconds and retry. The gate
  dismisses itself once `lastSubagentSettledAt` ages past
  `SUBAGENT_SETTLE_GRACE_MS`.

---

### 3. Empty-response stall after an approval

**Signal:** agent returns a turn with no content after a plan is
approved. Gateway log shows the retry path firing without surfacing
the original `[PLAN_DECISION]` context.

**Root cause:** post-approval ack-only retry fires within the 5-min
grace window (`POST_APPROVAL_ACK_ONLY_GRACE_MS`), but the synthetic
`[PLAN_DECISION]` injection was already consumed on the first
attempt.

**Status:** C4.2 (retry re-hydration) is deferred to a focused follow-up.
The current workaround is to re-invoke the agent with an explicit
message — the plan approval persists server-side, so the agent can
read it back via `plan_mode_status`.

---

### 4. Nudge cron noise during pending approval

**Signal:** repeated `[PLAN_NUDGE]` agent turns fire while the user's
approval card is still open.

**Diagnostic:**

```bash
grep 'plan-nudge' ~/.openclaw/logs/gateway.err.log | tail -10
```

**Fix:** C1-R2 (shipped in `906eb68403`) added the approval-pending
suppression guard at `src/cron/isolated-agent/run.ts:423-431`. If
nudges still fire during a pending approval, verify:

- `cronSession.sessionEntry.planMode.approval === "pending"` when the
  cron fires (visible in the `[plan-mode/nudge_event]` debug line).
- The cron payload carries the correct `planCycleId` — mismatched
  cycles are suppressed separately with "older plan cycle" summary.

---

### 5. Plan-mode state lost after compaction or restart

**Signal:** session was mid-plan before a compaction / gateway
restart; after recovery, `plan_mode_status` reports `mode: "normal"`
and the plan steps are gone.

**Diagnostic:**

```bash
grep 'state_transition' ~/.openclaw/logs/gateway.err.log | grep <sessionKey>
```

**Fix:** the `fresh-session-entry.ts` live-disk read path resolves
"planMode deleted" (post-approval) from "planMode missing" (compaction
loss). If the state was genuinely lost, the user must re-invoke
`/plan on` + let the agent re-propose. The approved-plan markdown
file at `~/.openclaw/agents/<agentId>/plans/plan-YYYY-MM-DD-<slug>.md`
is durable — use it to recover the plan text manually if needed.

---

## Shell-escape bypass attempts under acceptEdits

**Signal:** gateway log contains
`[plan-mode/gate_decision] allowed=false` lines with `constraint:
"destructive"` citing shell-escape constructs.

**Context:** C4.1 added layered-defense detection for destructive
verbs smuggled via env-var indirection (`$RM`), backtick/$(...)
subshells, quote concatenation (`"r""m"`), and hex/octal byte escapes
(`\x72m`, `\162m`). Legitimate commands rarely trigger these
patterns; if you see them fire, inspect the agent's intent — it's
usually a hallucinated or prompt-injected attempt.

**Investigation:**

```bash
grep 'gate_decision' ~/.openclaw/logs/gateway.err.log | grep destructive | tail
```

---

## Adversarial XSS in plan titles

**Signal:** a user reports suspicious rendering in a Telegram plan
attachment or webchat plan card.

**Context:** C1-R3 added adversarial regression coverage for plan
titles across all four render formats (HTML, markdown, plaintext,
slack-mrkdwn). The escape chain is `escapeHtml` +
`neutralizeMentions` + `buildPlanFilenameSlug` for filesystem writes.

**Investigation:**

```bash
# Re-run the XSS suite locally to verify the regression didn't drift.
pnpm test src/agents/plan-render.test.ts -t "XSS"
```

If a new adversarial payload slips through, add it as a new case
in `src/agents/plan-render.test.ts` under the "plan title XSS /
injection hardening" describe block.

---

## Disk-full during plan persistence

**Signal:** gateway log contains `[plan-bridge/storage]` warn lines
referencing `ENOSPC` / `EACCES` / `EIO`. Plan approval still completes
(non-blocking contract), but the durable audit artifact was lost.

**Fix:**

- `ENOSPC`: free space at `~/.openclaw/agents/<agentId>/plans/`.
- `EACCES`: check filesystem permissions on the agents directory.
- `EIO`: underlying storage / FUSE / NFS issue — not an OpenClaw
  bug.

Re-run `/plan restate` after fixing to re-materialize the markdown.

---

## Cross-channel approval dedup

**Signal:** a user reports a plan was approved twice (once in webchat,
once in Telegram) with two `[PLAN_DECISION]` injections in the agent
history.

**Context:** C1-R5 added concurrency dedup tests. The gateway's
`sessions.patch` handler applies serially; the second write sees the
post-first-write state and errors with `PLAN_APPROVAL_EXPIRED` (Bug
B code) or `pending approval` mismatch. If you observe a double
injection, the most likely cause is the client retrying a patch that
silently succeeded.

---

## Escalation path

If a symptom doesn't match any of the above and the debug log
contains unfamiliar `[plan-mode/*]` events, capture:

1. The full debug log window (5 minutes before → 5 minutes after).
2. The session key + agent ID.
3. The `approvalRunId` and `approvalId` from the relevant
   `approval_event` log lines (C7 correlation fields).
4. Open an issue at https://github.com/openclaw/openclaw/issues with
   the label `area:plan-mode`.
