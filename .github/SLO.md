# CI/CD Service Level Objectives

## Overview

This document defines service level objectives (SLOs) for the OpenClaw CI/CD pipeline. The target is **99% green CI** across all workflows with well-defined error budgets and escalation paths.

## Primary SLO Targets

| Metric | Target | Window | Measurement |
|--------|--------|--------|-------------|
| CI Pass Rate | ≥ 99% | 7-day rolling | Completed workflow runs with conclusion=success / total completed runs |
| Mean Time to Green (MTTG) | ≤ 15 min | 7-day rolling | Average time from push to first passing CI check |
| Flaky Test Rate | ≤ 1% | 30-day rolling | Tests that flip pass/fail without code change in the same commit |
| PR Merge Latency | ≤ 24h | 30-day rolling | Time from PR open to merge (applies to agent PRs) |

## Per-Workflow Targets

| Workflow | Pass Rate Target | Max Duration | Priority |
|----------|-----------------|--------------|----------|
| CI | ≥ 99% | 12 min | P0 |
| Dagger CI | ≥ 99% | 10 min | P0 |
| Docker Release | ≥ 99% | 15 min | P0 |
| Install Smoke | ≥ 99% | 5 min | P0 |
| Workflow Sanity | ≥ 99.5% | 2 min | P1 |
| CodeQL | ≥ 99% | 20 min | P1 |
| Shadow Healer | ≥ 95% | 8 min | P1 |

**Legend:**
- **P0:** Critical path — blocks merges; must maintain green
- **P1:** Important — impacts developer velocity; fix within 24h
- **P2:** Nice-to-have — address in next sprint

## Error Budget

### Monthly Allowance (per workflow)

For a workflow with 300+ runs per month:
- **99% target:** ~3 failures/month (error budget = 1%)
- **99.5% target:** ~1.5 failures/month (error budget = 0.5%)

### Usage Policy

- **Normal state:** Use failures for flaky tests, infrastructure noise
- **Budget exhausted:** Freeze non-critical changes, focus on stability
- **Recovery:** 72h of 100% pass rate to restore full budget
- Shadow Healer auto-creates fix PRs for known failure patterns (see Phase 2)

## Classification & Root Causes

### Expected Failure Categories (Budget-Neutral)

These failures do NOT consume error budget:
- Infrastructure timeouts (GitHub Actions runner unavailability)
- Third-party service outages (npm registry, Docker Hub)
- Transient network errors (< 2 minutes duration)
- Flaky tests (known and tracked; must be quarantined within 1 week)

### Code-Related Failures (Budget-Consuming)

These consume error budget and require immediate action:
- Merge conflicts or missing dependency updates
- Type errors or lint violations
- Test failures (non-flaky)
- Build or package errors

## Measurement & Reporting

### Data Collection

- **Tool:** `scripts/ci-metrics.py` (collects workflow runs from GitHub API)
- **Dashboard:** `.github/ci-health-dashboard.html` (generated weekly)
- **Update frequency:** Daily (automated via scheduled action)
- **Data retention:** 90 days of detailed metrics

### Metrics Collected

For each workflow run:
- Workflow name and ID
- Conclusion (success/failure/cancelled)
- Duration (start to end)
- Branch and commit SHA
- Commit message and author

### Dashboard Views

1. **7-day Pass Rate** (per workflow + aggregate)
2. **Mean Time to Green** (push to first passing check)
3. **Failure Reason Distribution** (categorized by root cause)
4. **Workflow Duration Trends** (performance regression detection)
5. **Error Budget Consumption** (monthly rollover)

## Escalation Path

### P0 Escalation: Pass Rate < 90% for 24h

**Action:**
1. Immediately pause non-critical merges
2. Create P0 issue with failure logs
3. Assign to on-call SRE (rotate weekly)
4. Run Shadow Healer diagnostics (`gh run view <run-id> --log`)
5. Prepare rollback plan if needed

**Resolution goal:** < 4h

### P1 Escalation: Pass Rate < 95% for 48h

**Action:**
1. Create P1 issue with root cause analysis
2. Add to overnight-queue.md (Phase 1 prioritization)
3. Assign to development team
4. Shadow Healer creates auto-fix PR if pattern detected

**Resolution goal:** < 24h

### P2 Escalation: Pass Rate < 99% for 7 days

**Action:**
1. Create P2 issue + link to overnight-queue.md
2. Shadow Healer investigates (may auto-create draft PR)
3. Schedule fix in next sprint planning
4. No merge block

**Resolution goal:** Next sprint

### P3 Routine: Any single workflow < 95% for 30 days

**Action:**
1. Log in metrics dashboard
2. Shadow Healer creates investigation comment
3. Add to overnight-queue.md Phase 3+ for refactoring

**Resolution goal:** Next quarter

## Shadow Healer Integration

Shadow Healer (Phase 2) monitors CI failures and auto-generates fix PRs:

- **Triggers:** On `workflow_run` event with `conclusion: failure`
- **Analysis:** Uses Claude GLM to extract failure reason from logs
- **Remediation:**
  - Creates draft PR for known patterns (SSG, lint, build, etc.)
  - Links to root cause analysis
  - Suggests test quarantine if flaky
  - Auto-merges if confidence > 95% and tests pass

**Known patterns being tracked:**
- SSG/Next.js build failures (force-dynamic, missing exports)
- Lint violations (ESLint, Oxlint)
- Test flakiness (timing, mock state)
- Docker build cache issues
- npm install race conditions

## Branch Protection Rules

To enforce these SLOs, enable branch protection on `main`:

```yaml
Require status checks to pass before merging:
  - Dagger CI ✓ (required)
  - CI ✓ (required)
  - Install Smoke ✓ (required)
  - Workflow Sanity ✓ (required)
  - CodeQL ✓ (required)

Require branches to be up to date before merging: enabled
Require code reviews: 1 approval (from CODEOWNERS)
Require signed commits: enabled
Allow auto-merge: enabled (so-that PRs auto-merge when ready)
Dismiss stale reviews: enabled
```

## Review Cadence

- **Weekly:** Automated report (if implemented) sent to #ci-health Slack channel
- **Monthly:** SLO review meeting (on-call SRE + tech lead)
  - Analyze top failure reasons
  - Adjust targets if needed (document rationale)
  - Celebrate 100% weeks
- **Quarterly:** SLO reset (error budget refresh on quarter boundary)

## Future Improvements (Phase 4+)

- [ ] Integration with Slack alerts (auto-notify on P0/P1 escalations)
- [ ] Performance regression detection (workflow duration anomalies)
- [ ] Flaky test quarantine automation (auto-skip known flaky tests, auto-comment)
- [ ] Cost tracking (GitHub Actions minutes, runner utilization)
- [ ] Rollback automation (auto-revert failing commits with confidence > 90%)

## References

- Overnight Queue: [.github/overnight-queue.md](./overnight-queue.md)
- CI Health Dashboard: [.github/ci-health-dashboard.html](./ci-health-dashboard.html)
- Metrics Collector: [scripts/ci-metrics.py](../scripts/ci-metrics.py)
- Branch Protection Setup: [README.md#CI-Governance](../README.md#CI-Governance)
