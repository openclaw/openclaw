---
summary: "Durable work objects, proof packets, and restart-safe worker tracking"
read_when:
  - Building orchestration around subagents, cron, or external workers
  - Adding evidence-first completion or restart recovery
title: "Work Objects"
---

# Work Objects

OpenClaw work objects are the durable orchestration record for autonomous work.
They capture the Symphony-style primitives OpenClaw needs without coupling the
runtime to Linear, Codex, or any single worker implementation.

A work object answers five questions:

1. What work was requested?
2. Which isolated worker/session is doing it?
3. What evidence proves progress or completion?
4. What proof packet should be shown or audited after completion?
5. What should happen after a gateway restart?

## Storage

Work objects are stored under the Gateway state directory:

```text
~/.openclaw/work-objects/objects.json
```

The file is written with temp-file-and-rename semantics so a gateway crash does
not leave a partial JSON file behind.

## Shape

Each object has:

- `id`: stable `wo_*` id.
- `kind`: `subagent`, `cron`, `manual`, or `external`.
- `status`: `queued`, `running`, `succeeded`, `failed`, `timed_out`,
  `interrupted`, `cancelled`, or `needs_review`.
- `source`: where it came from, such as `sessions_spawn` or `cron`.
- `actor`: run id, agent id, session key, or worker id.
- `requester`: session/channel origin for routing completion back.
- `isolation`: isolated session/workspace/sandbox details.
- `recovery`: restart policy and recovery attempts.
- `workerPolicy`: optional multi-worker quality gate.
- `workerRuns`: implementer/reviewer/verifier/judge runs attached to the
  object.
- `evidence`: append-only evidence entries.
- `proofPacket`: final evidence-first completion packet.

## Multi-worker policy

For coding work, OpenClaw has a built-in heterogeneous policy:

1. **Codex implementer**: first-pass implementation.
2. **Clawd / Claude Code reviewer**: Opus 4.7 via `opus47-cli`, used as an
   adversarial design and code review pass.
3. **Gemini CLI verifier**: `strongest_available`, so the runtime can use the
   strongest Gemini CLI model available at execution time instead of hardcoding
   today's model id.

The default policy id is `codex-clawd-gemini`. It requires all required worker
roles to pass before a work object should be treated as fully successful. This
is intentionally stronger than a Codex-only Symphony-style loop because final
completion depends on independent model-family review and verification.

`runCodingFanout()` is the first runner for this policy. It executes workers in
order:

1. `codex exec --full-auto ...` for implementation in the isolated worktree.
2. `claude --permission-mode bypassPermissions --print --model claude-opus-4-7 ...`
   for the Clawd review pass.
3. `gemini ...` for verification. If no Gemini model is specified, OpenClaw
   intentionally omits `--model` so the installed Gemini CLI can use its current
   strongest/default model at runtime.

Each worker must return a verdict beginning with `PASS`, `WARN`, or `FAIL`.
`FAIL` blocks final success. `WARN` is recorded in the proof packet and can be
used by higher-level policy to request human review.

## Ada medical-device regulatory gate

If a work object is tagged as Ada medical-device work, or its workspace/changed
files match known Ada medical-device repo paths such as `engineering/ada`,
`engineering/medical-engine`, `engineering/assessment-fe`,
`engineering/assess-2`, or `medical/*`, the fan-out policy becomes
`codex-clawd-gemini-ada-regulatory`.

That policy adds a required `judge` step for the Ada IEC 62304 regulatory
package. The runner will not mark the work object successful until a regulatory
package path is attached and exists. Without that package, the work object ends
as `needs_review`, with an explicit blocker telling the operator to run the
regulatory skill and attach the compliance package.

## Current integration

`sessions_spawn` now creates a durable work object for every subagent run.
The subagent registry stores the `workObjectId` beside the run id, updates the
object as lifecycle events arrive, and writes a proof packet when the worker
settles or the announce flow captures final output.

Subagent system prompts now ask workers to return evidence explicitly: tests,
files changed, commands, links, or a precise blocker.

## Restart behavior

The existing durable subagent registry already resumes pending completion
tracking after gateway restart. Work objects add an audit trail to that recovery:
when a restored subagent run is resumed, OpenClaw appends a restart-recovery
evidence item to the corresponding work object.

For future worker types, use `markInterruptedWorkObjects()` on startup if a
worker cannot be resumed automatically. This preserves the work request and
marks it for review instead of silently losing it.

## Proof packets

A proof packet is created on completion and includes:

- final status,
- concise summary,
- final output when available,
- evidence entries,
- worker-run verdicts for implementer/reviewer/verifier passes,
- metrics such as runtime and token counts when available.

This is the stable handoff format for dashboards, audits, user-facing summaries,
and future multi-worker orchestration.
