# CI/CD Pipeline Setup - Validation Checklist

## Prerequisites

- [ ] Git repository initialized (`.git/` exists)
- [ ] Git remote configured (`git remote -v` shows origin)
- [ ] Test framework configured (appropriate config for detected stack type)
- [ ] Local tests pass (test command succeeds)
- [ ] Team agrees on CI platform
- [ ] Access to CI platform settings (if updating)

### Multi-Stack Detection

- [ ] Test stack type detected or configured (`frontend`, `backend`, `fullstack`)
- [ ] Test framework detected or configured (Playwright, Cypress, Jest, Vitest, etc.)
- [ ] Stack-appropriate test commands identified

### Multi-Platform Detection

- [ ] CI platform detected or configured
- [ ] Supported platform: GitHub Actions, GitLab CI, Jenkins, Azure DevOps, Harness, or Circle CI
- [ ] Platform-specific template selected

Note: CI setup is typically a one-time task per repo and can be run any time after the test framework is configured.

## Process Steps

### Step 1: Preflight Checks

- [ ] Git repository validated
- [ ] Framework configuration detected
- [ ] Local test execution successful
- [ ] CI platform detected or selected
- [ ] Node version identified (.nvmrc or default)
- [ ] No blocking issues found

### Step 2: CI Pipeline Configuration

- [ ] CI configuration file created at platform-correct path
  - GitHub Actions: `.github/workflows/test.yml`
  - GitLab CI: `.gitlab-ci.yml`
  - Jenkins: `Jenkinsfile`
  - Azure DevOps: `azure-pipelines.yml`
  - Harness: `.harness/pipeline.yaml`
  - Circle CI: `.circleci/config.yml`
- [ ] File is syntactically valid (no YAML/Groovy errors)
- [ ] Correct framework commands configured for detected stack type
- [ ] Node version matches project
- [ ] Test directory paths correct
- [ ] Stack-conditional steps applied:
  - [ ] Browser install included for frontend/fullstack stacks
  - [ ] Browser install omitted for backend-only stacks
  - [ ] Test commands match detected framework

### Step 3: Parallel Sharding

- [ ] Matrix strategy configured (4 shards default)
- [ ] Shard syntax correct for framework
- [ ] fail-fast set to false
- [ ] Shard count appropriate for test suite size

### Step 4: Burn-In Loop

- [ ] Burn-in job created (frontend/fullstack stacks) or intentionally skipped (backend-only)
- [ ] 10 iterations configured (when enabled)
- [ ] Proper exit on failure (`|| exit 1`)
- [ ] Runs on appropriate triggers (PR, cron)
- [ ] Failure artifacts uploaded
- [ ] Backend-only stacks: burn-in skipped by default (documented reason: targets UI flakiness)

### Step 5: Caching Configuration

- [ ] Dependency cache configured (npm/yarn)
- [ ] Cache key uses lockfile hash
- [ ] Browser cache configured (Playwright/Cypress)
- [ ] Restore-keys defined for fallback
- [ ] Cache paths correct for platform

### Step 6: Artifact Collection

- [ ] Artifacts upload on failure only
- [ ] Correct artifact paths (test-results/, traces/, etc.)
- [ ] Retention days set (30 default)
- [ ] Artifact names unique per shard
- [ ] No sensitive data in artifacts

### Step 7: Retry Logic

- [ ] Retry action/strategy configured
- [ ] Max attempts: 2-3
- [ ] Timeout appropriate (30 min)
- [ ] Retry only on transient errors

### Step 8: Helper Scripts

- [ ] `scripts/test-changed.sh` created
- [ ] `scripts/ci-local.sh` created
- [ ] `scripts/burn-in.sh` created (optional)
- [ ] Scripts are executable (`chmod +x`)
- [ ] Scripts use correct test commands
- [ ] Shebang present (`#!/bin/bash`)

### Step 9: Documentation

- [ ] `docs/ci.md` created with pipeline guide
- [ ] `docs/ci-secrets-checklist.md` created
- [ ] Required secrets documented
- [ ] Setup instructions clear
- [ ] Troubleshooting section included
- [ ] Badge URLs provided (optional)

## Output Validation

### Configuration Validation

- [ ] CI file loads without errors
- [ ] All paths resolve correctly
- [ ] No hardcoded values (use env vars)
- [ ] Triggers configured (push, pull_request, schedule)
- [ ] Platform-specific syntax correct

### Execution Validation

- [ ] First CI run triggered (push to remote)
- [ ] Pipeline starts without errors
- [ ] All jobs appear in CI dashboard
- [ ] Caching works (check logs for cache hit)
- [ ] Tests execute in parallel
- [ ] Artifacts collected on failure

### Performance Validation

- [ ] Lint stage: <2 minutes
- [ ] Test stage (per shard): <10 minutes
- [ ] Burn-in stage: <30 minutes
- [ ] Total pipeline: <45 minutes
- [ ] Cache reduces install time by 2-5 minutes

## Quality Checks

### Best Practices Compliance

- [ ] Burn-in loop follows production patterns
- [ ] Parallel sharding configured optimally
- [ ] Failure-only artifact collection
- [ ] Selective testing enabled (optional)
- [ ] Retry logic handles transient failures only
- [ ] No secrets in configuration files

### Knowledge Base Alignment

- [ ] Burn-in pattern matches `ci-burn-in.md`
- [ ] Selective testing matches `selective-testing.md`
- [ ] Artifact collection matches `visual-debugging.md`
- [ ] Test quality matches `test-quality.md`

### Security Checks

- [ ] No credentials in CI configuration
- [ ] Secrets use platform secret management
- [ ] Environment variables for sensitive data
- [ ] Artifact retention appropriate (not too long)
- [ ] No debug output exposing secrets
- [ ] **MUST**: No `${{ inputs.* }}` or user-controlled GitHub context (`github.event.pull_request.title`, `github.event.issue.body`, `github.event.comment.body`, `github.head_ref`) directly in `run:` blocks — all passed through `env:` intermediaries and referenced as `"$ENV_VAR"`

## Integration Points

### Status File Integration

- [ ] CI setup logged in Quality & Testing Progress section
- [ ] Status updated with completion timestamp
- [ ] Platform and configuration noted

### Knowledge Base Integration

- [ ] Relevant knowledge fragments loaded
- [ ] Patterns applied from knowledge base
- [ ] Documentation references knowledge base
- [ ] Knowledge base references in README

### Workflow Dependencies

- [ ] `framework` workflow completed first
- [ ] Can proceed to `atdd` workflow after CI setup
- [ ] Can proceed to `automate` workflow
- [ ] CI integrates with `gate` workflow

## Completion Criteria

**All must be true:**

- [ ] All prerequisites met
- [ ] All process steps completed
- [ ] All output validations passed
- [ ] All quality checks passed
- [ ] All integration points verified
- [ ] First CI run successful
- [ ] Performance targets met
- [ ] Documentation complete

## Post-Workflow Actions

**User must complete:**

1. [ ] Commit CI configuration
2. [ ] Push to remote repository
3. [ ] Configure required secrets in CI platform
4. [ ] Open PR to trigger first CI run
5. [ ] Monitor and verify pipeline execution
6. [ ] Adjust parallelism if needed (based on actual run times)
7. [ ] Set up notifications (optional)

**Recommended next workflows:**

1. [ ] Run `atdd` workflow for test generation
2. [ ] Run `automate` workflow for coverage expansion
3. [ ] Run `gate` workflow for quality gates

## Rollback Procedure

If workflow fails:

1. [ ] Delete CI configuration file
2. [ ] Remove helper scripts directory
3. [ ] Remove documentation (docs/ci.md, etc.)
4. [ ] Clear CI platform secrets (if added)
5. [ ] Review error logs
6. [ ] Fix issues and retry workflow

## Notes

### Common Issues

**Issue**: CI file syntax errors

- **Solution**: Validate YAML syntax online or with linter

**Issue**: Tests fail in CI but pass locally

- **Solution**: Use `scripts/ci-local.sh` to mirror CI environment

**Issue**: Caching not working

- **Solution**: Check cache key formula, verify paths

**Issue**: Burn-in too slow

- **Solution**: Reduce iterations or run on cron only

### Platform-Specific

**GitHub Actions:**

- Secrets: Repository Settings → Secrets and variables → Actions
- Runners: Ubuntu latest recommended
- Concurrency limits: 20 jobs for free tier

**GitLab CI:**

- Variables: Project Settings → CI/CD → Variables
- Runners: Shared or project-specific
- Pipeline quota: 400 minutes/month free tier

**Jenkins:**

- Credentials: Manage Jenkins → Manage Credentials
- Agents: Configure build agents with Node.js
- Plugins: Pipeline, JUnit, HTML Publisher recommended

**Azure DevOps:**

- Variables: Pipelines → Library → Variable groups
- Agent pools: Azure-hosted or self-hosted
- Parallel jobs: 1 free (Microsoft-hosted)

**Harness:**

- Connectors: Configure container registry and code repo connectors
- Delegates: Install Harness delegate in target infrastructure
- Steps: Use Run steps with appropriate container images

---

**Checklist Complete**: Sign off when all items validated.

**Completed by:** {name}
**Date:** {date}
**Platform:** {GitHub Actions, GitLab CI, Other}
**Notes:** {notes}
