---
name: ship
description: |
  Release engineering — sync main, run tests, audit coverage, push branch,
  open PR. Bootstraps test frameworks if needed. One command from "code complete"
  to "PR ready for review".
---

# Ship — From Code Complete to PR

You are the release engineer. Take this branch from "done coding" to "PR ready for review."

**Related skills:** [review](../review/SKILL.md) | [land-and-deploy](../land-and-deploy/SKILL.md) | [qa](../qa/SKILL.md)

---

## Step 0: Detect Base Branch

1. `gh pr view --json baseRefName -q .baseRefName`
2. Fallback: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`
3. Fallback: `main`

---

## Step 1: Sync with Base

```bash
git fetch origin <base> --quiet
git merge origin/<base> --no-edit
```

If conflicts: resolve them. If complex conflicts, ask the user.

---

## Step 2: Run Tests

```bash
# Detect and run the project's test suite
npm test          # Node.js
bundle exec rake  # Ruby
pytest            # Python
go test ./...     # Go
cargo test        # Rust
```

**All tests must pass.** If tests fail:
1. Read the failure output
2. Fix the failing test (if it's a real bug, fix the bug)
3. Re-run tests
4. If stuck after 3 attempts, ask the user

---

## Step 3: Coverage Audit

Check test coverage for files changed in this branch:

```bash
git diff origin/<base> --name-only
```

For each changed file, check if corresponding tests exist. Flag gaps:

```
COVERAGE AUDIT
═══════════════════════════════════════
Changed files:     12
With tests:        9
Missing tests:     3
  - src/services/billing.ts (new service, no tests)
  - src/utils/formatter.ts (new utility, no tests)
  - src/api/webhook.ts (new endpoint, no tests)
═══════════════════════════════════════
```

If missing tests, write them before proceeding (unless the user explicitly opts out).

---

## Step 4: Push Branch

```bash
git push -u origin HEAD
```

---

## Step 5: Create PR

Generate a PR with:

- **Title**: Concise description of the change
- **Body**: What changed, why, and how to test
- **Labels**: If applicable (bug, feature, refactor)

```bash
gh pr create --title "..." --body "..."
```

---

## Step 6: Post-Ship Checklist

- [ ] Tests pass
- [ ] Coverage gaps addressed or acknowledged
- [ ] No uncommitted changes
- [ ] PR description is clear
- [ ] Documentation updated (suggest [document-release](../document-release/SKILL.md) if needed)

---

## Output

```
SHIP REPORT
═══════════════════════════════════════
Branch:           feature/my-feature
Base:             main
Tests:            42 pass, 0 fail
Coverage:         +9 new tests
PR:               github.com/org/repo/pull/123
═══════════════════════════════════════
```

After the PR is approved, use [land-and-deploy](../land-and-deploy/SKILL.md) to merge and deploy.
