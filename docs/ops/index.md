---
title: "Operations"
summary: "Production operations hub: SLOs, ownership, environments, observability, runbooks, reliability, and review cadence"
read_when:
  - Setting up or reviewing production operations
  - Looking for runbooks, postmortem templates, or DR drills
  - Understanding ownership, SLOs, or vulnerability response SLAs
---

# Operations

This section is the single source of truth for how OpenClaw is operated in production.
All docs here are living documents — update them as the system evolves.

## Contents

| Document | Purpose |
|---|---|
| [SLOs and Ownership](./slo-and-ownership.md) | Availability targets, severity levels, on-call/release/security owners |
| [Environments](./environments.md) | Dev / staging / prod separation, config and secrets strategy |
| [Observability](./observability.md) | Structured logging, metrics, tracing, alerts, and dashboards |
| [Runbooks](./runbooks.md) | Step-by-step response guides for common production incidents |
| [Postmortem Template](./postmortem-template.md) | Standard postmortem format for any incident |
| [Vulnerability SLA](./vulnerability-sla.md) | Triage and fix windows by severity, disclosure policy |
| [Flaky Test Policy](./flaky-test-policy.md) | Definition, detection, burn-down process |
| [Ops Review Cadence](./ops-review.md) | Weekly and quarterly review agendas and checklists |
| [DR Drills](./dr-drills.md) | Backup / restore drills, chaos runbooks, recovery targets |

## Three-phase production readiness

| Phase | Focus | Key deliverables |
|---|---|---|
| 1 | Governance | Branch protection, CI gate policy, SLOs, ownership, vulnerability SLA |
| 2 | Observability | Structured logs, metrics, alerting, runbooks |
| 3 | Reliability | DR drills, flaky-test burn-down, security maturity, resilience reviews |

## Related docs

- [Release Policy](../reference/RELEASING.md)
- [Security Policy](../../SECURITY.md)
- [Incident Response Plan](../../INCIDENT_RESPONSE.md)
- [Health Checks](../gateway/health.md)
- [Doctor](../gateway/doctor.md)
- [Contributing Guide](../../CONTRIBUTING.md)
