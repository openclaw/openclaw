# Contributing to Real Dispatch

Real Dispatch is an AI-first dispatch and closeout product for field service, built on the OpenClaw scaffold.
Contributions should strengthen dispatch reliability, traceability, and closeout quality.

## Project scope

- **Product:** Real Dispatch (dispatch data plane, job lifecycle, closeout outputs)
- **Scaffold:** OpenClaw runtime/control plane (channels, sessions, routing, scheduler)

Treat OpenClaw as infrastructure. Product behavior and source-of-truth state belong to Real Dispatch.

## Repository links

- **GitHub:** [https://github.com/bankszach/real-dispatch](https://github.com/bankszach/real-dispatch)
- **Upstream scaffold:** [https://github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)

## What to work on first

- intake normalization and schedulability checks
- scheduling/assignment correctness
- technician update and evidence capture flow
- closeout packet + invoice draft quality gates
- auditability, role boundaries, and operational safety

## Guardrails for all changes

- Keep dispatch state in structured storage, not prompt-only memory.
- Preserve or improve audit coverage for state-changing actions.
- Do not introduce public marketplace skill loading.
- Avoid adding arbitrary shell/OS execution pathways.
- Prefer narrow, role-scoped tools over broad generic tools.

## Development setup

```bash
pnpm install
pnpm build
pnpm check
pnpm test
```

Runtime baseline: Node **22+**.

## Integration model

- This repo uses **file-based handoffs only**. PRs and GitHub PR-based gates are no longer part of this workflow.
- Keep local commits for traceability and context, then hand off via artifacts in `handoff/`.
- Export either a bundle (`*.bundle`) or patch series (`*.patches/`) from a clean working tree and run gates before export:
  - `./scripts/handoff-export-bundle.sh E6-F1-S1 your_name 2026-02-16__1430 shadow-proposal handoff/inbox`
  - `./scripts/handoff-export-patch.sh E6-F1-S1 your_name 2026-02-16__1430 shadow-proposal handoff/inbox HEAD~1`
- Naming format must include the workstream id:
  - `E6-F1-S1__author__2026-02-16__shadow-proposal.bundle`
  - `E6-F1-S1__author__2026-02-16__shadow-proposal.patches/`

## Handoff checklist

- [ ] Dispatch lifecycle behavior is covered (intake/schedule/onsite/closeout as applicable).
- [ ] Audit events are emitted for state-changing actions.
- [ ] Role permissions remain least-privilege.
- [ ] `./scripts/handoff-verify.sh` passes in the artifact source repo.
- [ ] `handoff/inbox` artifact landed with a short handoff note.
- [ ] On successful verification, append ledger entry:
  - `echo "{\"ts\":\"$(date -Iseconds)\",\"artifact\":\"<name>\",\"result\":\"applied+green\"}" >> handoff/ledger.ndjson`

### Push protection

- The repo ships with `.githooks/pre-push` that blocks pushes.
- Configure it locally with:
  - `git config core.hooksPath .githooks`
- If your local remote exists for fetch-only workflows, disable push destinations with:
  - `git remote set-url --push origin DISABLED`
- Run `pnpm no-pr-language` before opening repository-wide updates to enforce file-handoff terminology.

## Commit guidance

Use concise, action-oriented commit messages, for example:

- `dispatch: enforce required evidence before closeout`
- `scheduling: persist slot confirmation provenance`
- `intake: normalize channel payload into ticket schema`

## Documentation contributions

When touching docs, keep terminology consistent with the product glossary:

- Ticket / Job
- Case file
- Closeout packet
- Control plane
- Data plane
- Toolset
