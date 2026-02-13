# RACI + Deliverables (Expert Roles → Artifacts)

This maps the expert roles you listed to concrete artifacts you can track in sprint planning.

## Artifact list (minimum for v0)
1) Canonical lifecycle + edge cases (state machine + SOP anchors)
2) v0 PRD + phased plan
3) dispatch-api architecture spec (idempotency, audit, boundaries)
4) Postgres schema + migrations
5) OpenAPI spec
6) Tool bridge spec + allowlist
7) Threat model + auth plan
8) Observability plan + runbooks
9) E2E harness + CI gate
10) UX spec (dispatcher cockpit + tech app)

## RACI table
| Artifact | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| 1) Lifecycle + edge cases | Dispatch domain expert | Product manager | Backend architect, QA | Team |
| 2) PRD + scope lock | Product manager | Founder | Dispatch expert, UX | Team |
| 3) Architecture spec | Backend architect | Product manager | Security, SRE, Integration | Team |
| 4) DB schema + migrations | DB engineer | Backend architect | QA, SRE | Team |
| 5) OpenAPI spec | Backend architect | Product manager | Integration engineer | Team |
| 6) Tool bridge + allowlist | Integration engineer | Backend architect | Security, PM | Team |
| 7) Threat model + auth | Security engineer | Product manager | Backend, SRE | Team |
| 8) Observability + runbooks | SRE/Observability | Backend architect | Security, PM | Team |
| 9) E2E harness + CI gate | QA automation | Product manager | Backend, Integration | Team |
| 10) UX spec | UX designer | Product manager | Dispatch expert | Team |

## Sprint “definition bottlenecks” (decide now)
- v0 state machine lock (no churn)
- tool surface lock (closed set)
- idempotency format and origin
- audit event schema lock
- the single canonical E2E scenario as the release gate

