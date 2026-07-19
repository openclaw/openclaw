---
summary: "Inspect opt-in durable runtime state without changing owner state"
read_when:
  - Diagnosing accepted work after a restart or long-running operation
  - Inspecting durable runs, wake obligations, delivery attempts, or uncertainty
  - Verifying that durable runtime is enabled and ready
title: "`openclaw durable`"
---

Use `openclaw durable` to inspect the opt-in durable runtime. The commands are
read-only: they do not acknowledge wakes, retry work, resume runs, resolve
uncertainty, initialize schema, or mutate an existing owner.

## Usage

```bash
openclaw durable health
openclaw durable stats
openclaw durable runs --limit 25
openclaw durable show <runtimeRunId>
openclaw durable timeline <runtimeRunId>
openclaw durable steps <runtimeRunId>
openclaw durable children <runtimeRunId>
openclaw durable parents <runtimeRunId>
openclaw durable why <runtimeRunId>
openclaw durable signals <runtimeRunId>
openclaw durable refs <runtimeRunId>
openclaw durable timers <runtimeRunId>
openclaw durable coordination <runtimeRunId>
openclaw durable obligations list --limit 50
openclaw durable wakes list --limit 50
openclaw durable wakes inspect <wakeId>
openclaw durable uncertainty list --limit 50
openclaw durable delivery-attempts list <wakeId> --limit 50
```

Add `--json` to any command for structured output. List limits are clamped to
500 records.

## Commands

- `health`: report configured mode, process health, read-only store readiness,
  and bounded counters.
- `stats`: report bounded durable store counters.
- `runs`: list recent durable executions.
- `show`: show one bounded run projection with steps, links, signals, refs,
  timers, and timeline evidence.
- `timeline`: show ordered event headers without raw event payloads.
- `steps`: show lifecycle and checkpoint refs without lease tokens or metadata.
- `children` and `parents`: show durable run correlations.
- `why`: explain why a run is waiting, terminal, lost, or awaiting an owner
  decision, and suggest read-only follow-up commands.
- `coordination`: show the bounded coordination projection used by operator
  surfaces.
- `signals`, `refs`, and `timers`: inspect bounded evidence for one run.
- `obligations list`: list unresolved source-backed obligations.
- `wakes list` and `wakes inspect`: inspect wake state, target resolution,
  delivery attempts, and unresolved uncertainty.
- `uncertainty list`: list unresolved ambiguous outcomes.
- `delivery-attempts list`: list bounded handoff evidence for one wake.

There are intentionally no `ack`, `retry`, `resume`, `replay`, `resolve`, or
`abandon` commands. A future mutation surface would need a separate authority
review covering caller identity, source revision, idempotency, reason, audit
evidence, and delegation through the canonical owner front door.

## Enablement

The normal OpenClaw configuration is authoritative:

```json5
{
  durable: {
    // "off" | "observe" | "authority"
    mode: "observe",
    worker: {
      pollIntervalMs: 1000,
      claimTtlMs: 300000,
    },
  },
}
```

- `off` disables durable state and worker behavior.
- `observe` records durable evidence without accepting recovery authority.
- `authority` enables fail-closed durable intake and source-backed recovery.

When durable runtime is disabled, inspection commands return a non-success
disabled result without opening or creating the shared state database. When it
is enabled, CLI reads require an already-installed durable schema and open the
shared SQLite database read-only. Inspection never runs schema installation or
migration.

## Output Boundary

Text and JSON output deliberately omit raw metadata, event payloads, arbitrary
facts/evidence objects, idempotency and dedupe keys, worker claim tokens,
storage URIs, and the SQLite file path. Error and explanation text is bounded.
Opaque refs remain visible so an operator can correlate evidence without
copying stored payload content into the inspection surface.

Queue acceptance, attached-session consumption, and external user delivery are
reported as distinct states. A pending or accepted handoff is not presented as
proof that a user received a message.

## Related

- [Gateway protocol](/gateway/protocol#durable-runtime-inspection)
- [Durable core architecture proposal](/specs/durable-core-proposal-architecture)
- [Durable core compatibility check plan](/specs/durable-core-proposal-test-plan)
