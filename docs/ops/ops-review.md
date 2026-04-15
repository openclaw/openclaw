---
title: "Ops Review Cadence"
summary: "Weekly and quarterly operations review agendas, checklists, and owners"
read_when:
  - Preparing for or running a weekly ops review
  - Running the quarterly resilience and security review
  - Onboarding a new on-call owner
---

# Ops Review Cadence

## Weekly ops review

**Frequency:** Every week (suggested: Monday or first working day of the week)
**Duration:** 30–45 minutes
**Owner:** On-call owner (rotating or permanent; see [SLOs and Ownership](./slo-and-ownership.md))
**Format:** Async-first — post the checklist in Discord `#ops-weekly` or as a GitHub Discussion;
escalate blockers synchronously only when needed.

### Agenda

#### 1. Incident review (10 min)

- Any S1/S2 incidents since last review? If yes, confirm postmortem is filed.
- Any open action items from previous postmortems? Status update on each.
- Any near-miss or S3 incidents worth a brief write-up?

#### 2. CI health (5 min)

- Is main CI green? Check: https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main
- New test failures or flaky test regressions this week?
- Any `flaky-test` issues opened since last week? (see [Flaky Test Policy](./flaky-test-policy.md))

#### 3. Security signals (10 min)

- New Dependabot PRs: merge or triage any open ones within SLA.
- New CodeQL alerts: classify per [Vulnerability SLA](./vulnerability-sla.md).
- New secret scanning alerts: use `$openclaw-secret-scanning-maintainer` skill.
- Any open GHSA advisories awaiting disclosure or fix?

#### 4. SLO health (5 min)

- Gateway uptime since last review (check supervisor restart count or logs).
- Any channel reconnect storms or prolonged disconnections?
- Any user-reported availability issues in Discord `#help`?

#### 5. Tech debt and backlog (5 min)

- Any blocking tech-debt items?
- Are any architecture violations or boundary issues accumulating?
  Check: `pnpm canon:check` and `pnpm deadcode:ci` artifact.

#### 6. Release status (5 min)

- Is there an active beta or pending stable release?
- Any beta blockers or release-blocking issues open?
- Release preflight run recently? (`pnpm release:check`)

---

## Weekly ops review output

Post a brief summary in Discord `#ops-weekly` or GitHub Discussions with:

- Date and reviewer
- Incidents: none / list
- CI: green / issues found
- Security alerts: count and status
- SLO status: healthy / degraded / breached
- Open action items added this week
- Any blockers requiring immediate attention

---

## Quarterly resilience review

**Frequency:** Every quarter (January, April, July, October)
**Duration:** 2–3 hours
**Owner:** Security owner + release owner; core maintainers as attendees
**Format:** Synchronous (call or in-person); document results in private maintainer docs
           and any public-safe summary in GitHub Discussions.

### Agenda

#### Part 1: Security maturity (60 min)

- Review all [Vulnerability SLA](./vulnerability-sla.md) metrics:
  - MTTA, MTTR by severity
  - CVEs issued
  - SLA misses and root causes
- Review CODEOWNERS coverage: are all sensitive surfaces owned?
- Review CodeQL alert backlog — any recurring patterns?
- Review Dependabot merge latency — are deps current?
- Threat model review: has the attack surface changed since last quarter?
  (New channels, tools, plugins, or auth surfaces)
- Secret rotation: are all shared secrets / API keys rotated per policy?
- Run `openclaw security audit` against the latest stable release.

#### Part 2: Performance and reliability (45 min)

- Review gateway uptime/restart counts for the quarter.
- Any sustained latency regressions? (p95 agent response time)
- Channel health monitor false-positive or false-negative incidents?
- Test suite performance: is `pnpm test` wall-clock time trending up?
  If yes, identify hot test files and plan improvements.
- Compaction behavior: any unusual token overflow or runaway compaction?
- Plugin SDK contract stability: any third-party plugin breakage reports?

#### Part 3: DR drills (30 min)

- Run at least one DR drill from [DR Drills](./dr-drills.md).
- Review drill results: did recovery meet the time targets?
- Update runbooks if the drill revealed gaps.

#### Part 4: Architecture and tech debt (45 min)

- Run `pnpm canon:check` and review boundary violations.
- Run `pnpm deadcode:ci` and review dead-code accumulation.
- Review `pnpm check:loc` — any files approaching 700 LOC limit?
- Review open refactor or boundary-fix issues.
- Are there any new third-party plugins that need SDK compat review?

### Quarterly review output

Produce:

1. **Security summary** — MTTA/MTTR metrics, CVEs, SLA misses, rotation status.
2. **Reliability summary** — uptime, latency, incident count.
3. **DR drill results** — which drills ran, pass/fail, RTO achieved.
4. **Action items** — issues filed for each gap found, owners assigned.
5. **Tech debt snapshot** — dead-code count, boundary violations, LOC hotspots.

File in private maintainer docs and post a public-safe summary in GitHub Discussions.
