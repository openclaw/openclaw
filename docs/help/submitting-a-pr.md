---
summary: "How to submit a high signal PR"
title: "Submitting a PR"
---

# Submitting a PR

Good PRs make it easy for reviewers to understand intent, verify behavior, and land changes safely. This guide focuses on high-signal, low-noise submissions that work well with both human review and LLM-assisted review.

## What makes a good PR

- [ ] Clear intent: explain the problem, why it matters, and what the change does.
- [ ] Tight scope: keep changes focused and avoid drive-by refactors.
- [ ] Behavior summary: call out user-visible changes, config changes, and defaults.
- [ ] Tests: list what ran, what was skipped, and why.
- [ ] Evidence: include logs, screenshots, or short recordings for UI or workflows.
- [ ] Code word: include “lobster-biscuit” somewhere in the PR description to confirm you read this guide.
- [ ] Baseline checks: run the relevant `pnpm` commands for this repo and fix failures before opening the PR.
- [ ] Due diligence: search the codebase for existing functionality and check GitHub for related issues or prior fixes.
- [ ] Grounded in reality: claims should be backed by evidence, reproduction, or direct observation.
- [ ] Title guidance: use a verb + scope + outcome (for example `Docs: add PR and issue templates`).

Guideline: concision > grammar. Be terse if it makes review faster.

Baseline validation commands (run as appropriate for the change, and fix failures before submitting):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- If you touch protocol code: `pnpm protocol:check`

## Progressive disclosure

Use a short top section, then deeper details as needed.

1. Summary and intent
2. Behavior changes and risks
3. Tests and verification
4. Implementation details and evidence

This keeps review fast while preserving deep context for anyone who needs it.

## Common PR types and expectations

- [ ] Fix: include clear repro, root cause summary, and verification steps.
- [ ] Feature: include use cases, behavior changes, and screenshots or demos when UI is involved.
- [ ] Refactor: explicitly state “no behavior change” and list what moved or was simplified.
- [ ] Chore/Maintenance: note why it matters (build time, CI stability, dependency hygiene).
- [ ] Docs: include before/after context and link to the updated page. Run `pnpm format`.
- [ ] Test: explain the gap it covers and how it prevents regressions.
- [ ] Perf: include baseline and after metrics, plus how they were measured.
- [ ] UX/UI: include screenshots or short recordings and any accessibility impact.
- [ ] Infra/Build: call out affected environments and how to validate.
- [ ] Security: include threat or risk summary, repro steps, and verification plan. Avoid sensitive data in public logs.
- [ ] Security: keep reports grounded in reality; avoid speculative claims.

## Checklist

- [ ] Problem and intent are clear
- [ ] Scope is focused
- [ ] Behavior changes are listed
- [ ] Tests are listed with results
- [ ] Evidence is attached when needed
- [ ] No secrets or private data
- [ ] Grounded in reality: no guesswork or invented context.

## Template

```md
## Summary

## Behavior Changes

## Codebase and GitHub Search

## Tests

## Evidence

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

## Templates by PR type

### Fix

```md
## Summary

## Repro Steps

## Root Cause

## Behavior Changes

## Tests

## Evidence

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### Feature

```md
## Summary

## Use Cases

## Behavior Changes

## Existing Functionality Check

- [ ] I searched the codebase for existing functionality before implementing this.

Searches performed (1-3 bullets, one sentence each):

-
-

## Tests

## Evidence

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### Refactor

```md
## Summary

## Scope

## No Behavior Change Statement

## Tests

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### Chore/Maintenance

```md
## Summary

## Why This Matters

## Tests

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### Docs

```md
## Summary

## Pages Updated

## Screenshots or Before/After

## Formatting

pnpm format

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### Test

```md
## Summary

## Gap Covered

## Tests

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### Perf

```md
## Summary

## Baseline

## After

## Measurement Method

## Tests

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### UX/UI

```md
## Summary

## Screenshots or Video

## Accessibility Impact

## Tests

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### Infra/Build

```md
## Summary

## Environments Affected

## Validation Steps

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```

### Security

```md
## Summary

## Risk Summary

## Repro Steps

## Mitigation or Fix

## Verification

## Tests

## Sign-Off

- Models used:
- Submitter effort summary (self-reported, subjective):
- Agent notes (optional; brief; cite evidence):
```
