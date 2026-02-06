---
summary: "How to file high signal issues and bug reports"
title: "Submitting an Issue"
---

# Submitting an Issue

Good issues make it easy to reproduce, diagnose, and fix problems quickly. This guide covers what to include for bugs, regressions, and feature gaps.

## What makes a good issue

- [ ] Clear title: include the area and the symptom.
- [ ] Repro steps: minimal steps that consistently reproduce the issue.
- [ ] Expected vs actual: what you thought would happen and what did.
- [ ] Impact: who is affected and how severe the problem is.
- [ ] Environment: OS, runtime, versions, and relevant config.
- [ ] Evidence: logs, screenshots, or recordings (redacted; prefer non-PII data).
- [ ] Scope: note if it is new, regression, or long-standing.
- [ ] Code word: include “lobster-biscuit” somewhere in the issue description to confirm you read this guide.
- [ ] Due diligence: search the codebase for existing functionality and check GitHub to see if the issue is already filed or fixed.
- [ ] I searched for existing and recently closed issues/PRs.
- [ ] For security reports: confirmed it has not already been fixed or addressed recently.
- [ ] Grounded in reality: claims should be backed by evidence, reproduction, or direct observation.

Guideline: concision > grammar. Be terse if it makes review faster.

Baseline validation commands (run as appropriate for the change, and fix failures before submitting a PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- If you touch protocol code: `pnpm protocol:check`

## Templates

### Bug report

```md
## Bug report checklist

- [ ] Minimal repro steps
- [ ] Expected vs actual
- [ ] Versions and environment
- [ ] Affected channels and where it does not reproduce
- [ ] Logs or screenshots
- [ ] Evidence is redacted and non-PII where possible
- [ ] Impact and severity
- [ ] Any known workarounds

## Summary

## Repro Steps

## Expected

## Actual

## Environment

## Logs or Evidence

## Impact

## Workarounds
```

### Security issue

```md
## Summary

## Impact

## Affected Versions

## Repro Steps (if safe to share)

## Mitigation or Workaround

## Evidence (redacted)
```

Security note: avoid posting secrets or exploit details in public issues. If the report is sensitive, keep repro details minimal and ask for a private disclosure path.

### Regression report

```md
## Summary

## Last Known Good

## First Known Bad

## Repro Steps

## Expected

## Actual

## Environment

## Logs or Evidence

## Impact
```

### Feature request

```md
## Summary

## Problem

## Proposed Solution

## Alternatives Considered

## Impact

## Evidence or Examples
```

### Enhancement request

```md
## Summary

## Current Behavior

## Desired Behavior

## Why This Matters

## Alternatives Considered

## Evidence or Examples
```

### Investigation request

```md
## Summary

## Symptoms

## What Was Tried

## Environment

## Logs or Evidence

## Impact
```

## If you are submitting a fix PR

Creating a separate issue first is optional. If you skip it, include the relevant details in the PR description.

- Keep the PR focused on the issue.
- Include the issue number in the PR description.
- Add tests when possible, or explain why they are not feasible.
- Note any behavior changes and risks.
- Include redacted logs, screenshots, or videos that validate the fix.
- Run relevant `pnpm` validation commands and report results when appropriate.
