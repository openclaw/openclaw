# Real Dispatch

**AI-first dispatch and closeout system for field service.**

Real Dispatch replaces the front-desk dispatcher role for service companies by handling:

- intake from real customer channels
- scheduling and technician coordination
- onsite updates and evidence capture
- closeout packet generation
- billing-ready job records

Real Dispatch is built on the OpenClaw scaffold for **control-plane** capabilities (channels, sessions, routing, scheduler wakeups, and runtime orchestration).
Real Dispatch itself is the **dispatch data plane**: structured job state, audit trail, attachments, and closeout outputs.

## What this is (and is not)

Real Dispatch is not a general-purpose personal assistant.
It is a dispatch operating system for service work, optimized for schedulability, traceability, and clean closeout.

## Mission

Real Dispatch is the always-on intake, scheduling, technician liaison, and closeout engine that produces a complete billing-ready record for every job.

## End-to-end workflow

`intake -> schedule -> dispatch -> onsite comms -> closeout packet -> invoice draft`

## Core design principles

- **System-of-record first:** ticket and case state live in structured storage, not chat history.
- **Closed toolset:** agents can only call explicitly allowed dispatch actions.
- **Least privilege:** each role has narrow access and strict state transitions.
- **Auditability:** every action is logged with actor, timestamp, and provenance.
- **Safety defaults:** untrusted inbound messages are gated and sanitized.

## Architecture

### Control plane (OpenClaw scaffold)

- channels and inbox routing
- sessions and presence
- scheduler wakeups and webhook triggers
- operator-facing control surfaces

### Data plane (Real Dispatch)

- tickets/jobs, customers, technicians, schedules
- attachments (photos, forms, documents)
- audit log and replayable event timeline
- closeout packet and invoice outputs

## Reuse roadmap

Detailed scaffold-to-product mapping lives in:

- [OpenClaw to Real Dispatch reuse plan](docs/concepts/openclaw-reuse-plan.md)

## Glossary

- **Ticket / Job**: unit of work.
- **Case file**: canonical structured record of a job (database + attachments).
- **Closeout packet**: compiled bundle of photos, notes, labor/parts, signatures, and required evidence.
- **Control plane**: OpenClaw gateway, channels, scheduler, and runtime orchestration.
- **Data plane**: `dispatch-api` + database + object storage.
- **Toolset**: closed list of allowed actions; no arbitrary execution.

## MVP capability contract

### Intake

- convert multi-channel inbound messages into structured tickets
- ask minimum required follow-up questions to become schedulable
- send immediate confirmation with next step

### Scheduling

- propose slots, confirm, and reschedule
- assign technicians by scope/availability
- publish ETA updates to customers

### Technician loop

- receive technician acknowledgements
- capture onsite updates
- enforce photo + notes capture
- enforce closeout checklist completion

### Closeout and billing

- generate closeout packet
- generate invoice draft
- flag missing evidence before finalization

### Safety and governance

- no public marketplace skills
- closed toolset only
- audit log for every state-changing action
- least privilege per agent role

## Repository status

This repository is in active overhaul from upstream OpenClaw.
Expect rapid structural changes while dispatch-first architecture is being finalized.

## Development quickstart

Runtime baseline: **Node 22+**.

```bash
pnpm install
pnpm build
pnpm check
pnpm test
```

## License

MIT (inherits upstream licensing unless otherwise noted).
OpenClaw remains control-plane infrastructure; Real Dispatch is a distinct dispatch product built on top.
