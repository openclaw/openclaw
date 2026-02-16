# Real Dispatch vNext Agile Implementation Package

**Date:** 2026-02-15  
**Scope:** Move `bankszach/real-dispatch` from current state → vNext 3-plane architecture (Data Plane / Control Plane (Temporal TS) / Edge Adapters) while preserving the non-negotiable invariant: **Real Dispatch remains the enforced system of record; no agent gets DB write privileges.**

## How to use this package

1. Start with `00-Executive/01-Overview.md` and `00-Executive/02-Current-vs-Target.md`.
2. Engineering leadership should review `02-Backlog/` and choose a start date; the pack assumes 2-week sprints starting **Mon Feb 16, 2026**.
3. Team executes PR-by-PR from `03-Delivery/01-PR-Plan.md` (each PR is shippable and reversible with feature flags).
4. DB changes are staged per `04-Data/01-Migrations-Plan.md`.
5. Control-plane work follows `05-Control-Plane/`.
6. Edge adapters follow `06-Edge/`.
7. Track risks and mitigations in `07-Risks/`.

## Directory map

- `00-Executive/` – the why, the bet, and the plan at a glance
- `01-Architecture/` – boundaries, contracts, diagrams, repo layout
- `02-Backlog/` – Epics → Features → Stories, acceptance criteria, definition of done
- `03-Delivery/` – sprint plan, PR plan (15–20 PRs), release gates, feature flags
- `04-Data/` – schema/migrations, tenancy/RLS rollout, outbox, evidence tables
- `05-Control-Plane/` – Temporal design: workflows, activities, signals, testing strategy
- `06-Edge/` – adapters: comms, evidence ingest, optimizer, conventions
- `07-Risks/` – risk register + mitigations + validation experiments
- `08-Runbooks/` – ops runbooks, incident response, kill-switch procedures
- `09-Templates/` – story templates, PR template, ADR template
