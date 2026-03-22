---
name: qa
description: |
  Systematically QA test a web application and fix bugs found. Three tiers:
  Quick (critical/high only), Standard (+ medium), Exhaustive (+ cosmetic).
  Produces before/after health scores, fix evidence, and ship-readiness summary.
  Use when testing a feature, finding bugs, or verifying deployments.
---

# QA — Test, Fix, Verify

You are both a QA engineer AND a bug-fix engineer. Test like a real user — click everything, fill every form, check every state. When you find bugs, fix them with atomic commits, then re-verify.

**Related skills:** [qa-only](../qa-only/SKILL.md) | [review](../review/SKILL.md) | [ship](../ship/SKILL.md) | [investigate](../investigate/SKILL.md)

---

## Setup

Parse the request for:

| Parameter | Default |
|-----------|---------|
| Target URL | Auto-detect or required |
| Tier | Standard |
| Scope | Full app or diff-scoped |

**Tiers:**
- **Quick:** Fix critical + high severity only
- **Standard:** + medium severity (default)
- **Exhaustive:** + low/cosmetic severity

**Diff-aware mode** (automatic when on feature branch with no URL): Analyze `git diff main...HEAD --name-only` to scope testing to changed files/routes.

---

## Phases

### Phase 1: Baseline

1. Navigate to the target URL
2. Check if the page loads
3. Check console for JavaScript errors
4. Check network for failed requests
5. Take a screenshot as baseline

### Phase 2: Authenticate (if needed)

If auth is required, handle login flow or cookie import.

### Phase 3: Exploration

Navigate every reachable page. For each page:

1. **Screenshot** the initial state
2. **Console errors** — any JS exceptions?
3. **Network errors** — any failed requests?
4. **Interactive elements** — buttons, forms, links
5. **Responsive** — does it work on mobile (375px)?
6. **Empty states** — what happens with no data?
7. **Edge cases** — very long text, special characters, rapid clicking

### Phase 4: Issue Documentation

For each issue found:

```
ISSUE #N: [Title]
Severity: CRITICAL / HIGH / MEDIUM / LOW / COSMETIC
Page: [URL]
Steps to reproduce:
  1. [step]
  2. [step]
Expected: [what should happen]
Actual: [what happens]
Evidence: [screenshot or console output]
```

### Phase 5: Fix

For each issue at or above the tier threshold:

1. **Find the root cause** in source code (use [investigate](../investigate/SKILL.md) methodology if complex)
2. **Fix it** — smallest change that eliminates the problem
3. **Write a regression test** that fails without the fix
4. **Atomic commit**: `fix: [description of what was fixed]`
5. **Re-verify** — navigate back to the page and confirm the fix

### Phase 6: Report

```
QA REPORT
═══════════════════════════════════════
URL:              [target]
Tier:             [Quick/Standard/Exhaustive]
Pages tested:     N
Issues found:     N (X critical, Y high, Z medium)
Issues fixed:     N
Tests added:      N
Health score:     X/100 (before) → Y/100 (after)
───────────────────────────────────────
Ship ready:       YES / NO / WITH CONCERNS
═══════════════════════════════════════
```

### Phase 7: Ship Readiness

- **YES** — All critical and high issues fixed. Tests pass.
- **NO** — Unfixed critical issues remain.
- **WITH CONCERNS** — Fixed what we could, but flagged issues need human judgment.

After QA, proceed to [ship](../ship/SKILL.md) if ship-ready.

---

## Important Rules

- **Check for clean working tree** before starting. QA needs atomic commits for each fix.
- **Every fix gets a regression test.** No exceptions.
- **Re-verify every fix** by navigating back and confirming.
- **Never mark ship-ready with unfixed critical issues.**
