---
name: land-and-deploy
description: |
  Merge the PR, wait for CI and deploy, verify production health.
  Takes over after ship. One command from "approved" to "verified in production."
---

# Land and Deploy — From Approved to Verified

Takes over where [ship](../ship/SKILL.md) left off. Merge, deploy, verify.

**Related skills:** [ship](../ship/SKILL.md) | [canary](../canary/SKILL.md) | [qa](../qa/SKILL.md)

---

## Step 1: Pre-Merge Checks

```bash
gh pr checks
gh pr view --json reviewDecision -q .reviewDecision
```

- All CI checks must pass
- PR must be approved (or the user explicitly overrides)

---

## Step 2: Merge

```bash
gh pr merge --squash --delete-branch
```

Use squash merge by default (clean history). If the user prefers merge commits, honor that.

---

## Step 3: Wait for Deploy

Monitor the deployment:

1. Check CI/CD status after merge
2. Wait for deploy to complete (poll deployment status)
3. If deploy fails, alert the user immediately

---

## Step 4: Production Verification

After deploy completes:

1. Navigate to the production URL
2. Verify the shipped feature works
3. Check for console errors
4. Check for network errors
5. Screenshot key pages

---

## Step 5: Post-Deploy

```
DEPLOY REPORT
═══════════════════════════════════════
PR:               #123 (merged)
Deploy status:    SUCCESS
Production URL:   https://app.example.com
Verification:     PASS
═══════════════════════════════════════
```

If something breaks, offer to revert:
```bash
gh pr create --title "Revert: ..." --body "Reverting PR #123 due to ..."
```

For extended monitoring, use [canary](../canary/SKILL.md).
