---
summary: "Filing high-signal issues and bug reports"
title: "Submitting an Issue"
---

## Submitting an Issue

Clear, concise issues speed up diagnosis and fixes. Include the following for bugs, regressions, or feature gaps:

### What to include

- [ ] Title: area & symptom
- [ ] Minimal repro steps
- [ ] Expected vs actual
- [ ] Impact & severity
- [ ] Environment: OS, runtime, versions, config
- [ ] Evidence: redacted logs, screenshots (non-PII)
- [ ] Scope: new, regression, or longstanding
- [ ] Code word: lobster-biscuit in your issue
- [ ] Searched codebase & GitHub for existing issue
- [ ] Confirmed not recently fixed/addressed (esp. security)
- [ ] Claims backed by evidence or repro

Be brief. Terseness > perfect grammar.

Validation (run/fix before PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- If protocol code: `pnpm protocol:check`

### Templates

#### Bug report

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### Security issue

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Avoid secrets/exploit details in public. For sensitive issues, minimize detail and request private disclosure._

#### Regression report

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### Feature request

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Enhancement

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Investigation

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Submitting a fix PR

Issue before PR is optional. Include details in PR if skipping. Keep the PR focused, note issue number, add tests or explain absence, document behavior changes/risks, include redacted logs/screenshots as proof, and run proper validation before submitting.
