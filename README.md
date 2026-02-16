# Real Dispatch

**AI-first dispatch and closeout system for field service.**

Real Dispatch uses OpenClaw as a control plane and keeps all operational truth in a dedicated dispatch data plane.

## Product direction (locked)

- OpenClaw is the control plane: channels, sessions, routing, scheduler, runtime.
- Real Dispatch is the data plane: case files, transitions, audit trail, closeout artifacts, invoice drafts.
- State changes happen only through a closed dispatch toolset backed by dispatch-api.

## Operator Lifecycle (Phase Model)

`new -> triaged -> schedulable -> scheduled -> dispatched -> onsite -> closeout_pending -> closed`

Detailed dispatch-api enforcement states and phase mapping:

- `dispatch/contracts/case-lifecycle-v1.md`

## Agent roles

- Intake Agent
- Scheduling Agent
- Technician Liaison Agent
- Closeout Agent

Role policies and transition boundaries are defined in `/AGENTS.md`.

## Closed toolset (v0)

- `ticket.create`
- `ticket.triage`
- `schedule.propose`
- `schedule.confirm`
- `assignment.dispatch`
- `tech.check_in`
- `tech.request_change`
- `approval.decide`
- `closeout.add_evidence`
- `tech.complete`
- `qa.verify`
- `billing.generate_invoice`
- `ticket.get`
- `closeout.list_evidence`
- `ticket.timeline`

## Architecture

### Control plane (OpenClaw scaffold)

- channel adapters and inbox routing
- session orchestration and agent runtime
- scheduler/cron wakeups
- operator-facing control surfaces

### Data plane (Real Dispatch)

- tickets/jobs and case-file schema
- schedule and assignment history
- technician timeline + attachments
- closeout checklist + packet generation
- invoice draft generation
- immutable audit stream

## Repository structure (dispatch-first)

- `/dispatch` product scaffold for the data plane and workflow logic
- `/src` OpenClaw scaffold runtime and integration points
- `/docs` product, architecture, and operational references
- `/AGENTS.md` production role policies

## Key docs

- [Dispatch contract RFC](docs/rfcs/0001-dispatch-core-contracts-v0.md)
- [OpenClaw reuse plan](docs/concepts/openclaw-reuse-plan.md)
- [Dispatch setup guide](docs/start/openclaw.md)

Canonical agile planning source:

- [real-dispatch-agile-package](real-dispatch-agile-package/README.md)
- [Definition of Done](real-dispatch-agile-package/02-Backlog/00-Definition-of-Done.md)
- [Stories and epic sequence](real-dispatch-agile-package/02-Backlog/02-Stories.md)
- [Release gates](real-dispatch-agile-package/03-Delivery/00-Release-Gates.md)
- [PR plan](real-dispatch-agile-package/03-Delivery/03-PR-Plan.md)

## Development quickstart

Runtime baseline: **Node 22+**.

```bash
cp .env.example .env
pnpm install
pnpm build
pnpm check
pnpm test
```

Dispatch topology helpers:

```bash
pnpm dispatch:stack:up
pnpm dispatch:bootstrap      # apply migration + demo fixtures
pnpm dispatch:stack:status
pnpm dispatch:stack:down
```

Demo one-shot startup:

```bash
pnpm dispatch:demo:stack
```

Dispatch CI parity gate (same command used by blocking CI):

```bash
pnpm dispatch:test:ci
```

Dispatch gate passing criteria:

- TAP output includes `dispatch/tests/001_init_migration.node.test.mjs`.
- TAP output includes `dispatch/tests/story_08_e2e_canonical.node.test.mjs`.
- Test summary includes `fail 0`.

## Status

This repository is intentionally in active scaffold-to-product migration.
OpenClaw remains the base; Real Dispatch product boundaries are now locked around the lifecycle, role policy, and closed-tool contract.

## License

MIT (inherits upstream licensing unless otherwise noted).
