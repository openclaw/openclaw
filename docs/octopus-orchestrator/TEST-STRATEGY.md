# OpenClaw Octopus Orchestrator — Test Strategy

## Status

Milestone 0 draft. Owns the concrete definition of "validated in Milestone N" language used throughout PRD/HLD/LLD/implementation-plan exit criteria.

## Test layers

### 1. Unit tests

Scope: individual services and modules in isolation.

Coverage targets:

- State machine transitions (ArmRecord, GripRecord, MissionRecord) — every valid and invalid transition exercised
- Event schema validation — every event type round-trips through TypeBox validator
- Scheduler scoring function — deterministic outputs for a canonical fixture set
- RetryPolicy evaluation — every failure classification produces the expected next action
- Capability matching — hard filters, prefix wildcards, negative matches
- CAS update semantics — concurrent writers see conflict correctly

Tooling: existing OpenClaw test harness. Runs on every PR.

### 2. Adapter contract tests

Scope: each adapter (SubagentAdapter, AcpAdapter, PtyTmuxAdapter) tested against a shared behavioral contract.

Each adapter must pass:

- `spawn` returns a valid SessionRef
- `resume` on a known session restores state; on an unknown session returns structured error
- `stream` produces events conforming to the normalized event schema
- `send` is idempotent under duplicate idempotency keys
- `checkpoint` round-trips through persistence
- `terminate` reaches an observable terminal state within the expected window
- `health` returns a structured snapshot even when the underlying runtime is unreachable

Fixture runtimes:

- SubagentAdapter: test harness subagent
- AcpAdapter: a stub `acpx` backend with canned responses
- PtyTmuxAdapter: a scripted shell that emits known patterns

Runs on every PR that touches adapter code.

### 3. Integration tests

Scope: Head + one Node Agent, both running in-process, talking over an in-memory Gateway WS transport.

Canonical scenarios:

- Spawn a mission with 5 grips, verify all reach `grip.completed`
- Spawn a mission, kill the Head, restart, verify replay rebuilds correct state
- Spawn an arm, kill the Node Agent, verify reconciliation on restart rebinds the session
- Operator attaches to a live arm, sends input, receives output, detaches cleanly
- Two arms request conflicting claims; verify one blocks and one proceeds
- Mission budget exceeded triggers the configured `on_exceed` action

Runs nightly and pre-merge on trunk.

### 4. Chaos tests

Scope: Head + multiple Node Agents in separate processes under deliberately adversarial conditions.

**Mandatory scenarios (block milestone exit):**

| Milestone | Scenario                                            | Pass condition                                                                                               |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M1        | Kill local arm process during execution             | Arm detected, restart count incremented, state visible within 60s                                            |
| M1        | Kill Gateway process during active arms             | Restart recovers arms without duplicate execution; event log replay produces correct final state             |
| M1        | Disk fill on events.jsonl partition                 | Head enters degraded state, refuses new spawns, emits anomaly, does not corrupt existing log                 |
| M2        | Adapter emits malformed events                      | Malformed events rejected, arm continues, anomaly event recorded                                             |
| M2        | Subagent session expires mid-grip                   | Adapter surfaces the expiry, grip retries per policy                                                         |
| M3        | Two arms claim the same file concurrently           | Exactly one wins; loser blocks and retries                                                                   |
| M3        | Grip ambiguity: two arms complete the same grip     | Both results quarantined, operator prompted, no auto-merge                                                   |
| M4        | Kill a Node Agent mid-arm (network partition proxy) | Lease grace window elapses, arm recovered or reassigned, duplicate-execution rate <5% per PRD success metric |
| M4        | Node Agent returns wrong idempotency key            | Request rejected, no state change                                                                            |
| M4        | Clock skew ±30s between Head and Node Agent         | Leases still honored, no premature reassignment                                                              |
| M5        | Policy denies a spawn                               | No arm created, denial recorded with actor and rule id                                                       |
| M5        | Operator attempts action without `octo.writer`      | Rejected, audit event written                                                                                |

### 5. Soak tests

Scope: long-running scenarios to catch leaks, drift, and slow failures.

- 24-hour run: 10 concurrent arms, new grip every 60s, verify no memory growth, no file descriptor growth, no event log corruption
- 72-hour run: 3 missions running continuously, verify event log archival rotation works and replay from archive is correct
- Node Agent churn: connect/disconnect cycle every 5 minutes for 24h, verify lease book stays consistent

Runs weekly on a dedicated test environment.

## Test data and fixtures

- Canonical mission fixtures live in `src/octo/test/fixtures/missions/`
- Canonical scheduler fixtures live in `src/octo/test/fixtures/scheduler/`
- Event log replay snapshots live in `src/octo/test/fixtures/events/` — one per schema_version bump
- Each fixture is a JSON file with input, expected terminal state, and expected event sequence

## Success metric validation

The PRD lists five concrete success metrics. Each is mapped to specific tests:

| PRD metric                                                    | Validating test                                           |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Time to spawn and supervise 10 arms under 30s                 | Integration test: `spawn-10-arms-under-30s`               |
| 95% of arm failures recoverable without manual reconstruction | Chaos test aggregate across M1–M4                         |
| Reattach success rate >99% for active sessions                | Soak test: reattach every 5m for 24h                      |
| Duplicate work after failover <5% of task volume              | M4 chaos test: `kill-node-during-arm`                     |
| Mean operator time to diagnose failed arm <2 min              | Manual test with recorded session, measured per milestone |

Failing any mapped test blocks milestone exit.

## Who runs what

- Unit and adapter contract tests: CI on every PR
- Integration tests: nightly CI + pre-merge on trunk
- Chaos tests: gated at milestone exit; run manually or via a dedicated CI lane
- Soak tests: weekly scheduled CI
- Success metric validation: milestone exit checklist

## Related

- PRD §Success Metrics, §Risks
- LLD §Recovery Flows, §Backpressure, §Retry and Backoff
- DECISIONS.md OCTO-DEC-007 (lease windows validated in M1 chaos)
