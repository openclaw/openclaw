---
# -- Dart AI metadata ----------------------------------------------------------
title: "Upstream Selective Sync Process"
description: "Process doc for cherry-picking fixes and features from upstream openclaw into operator1"
dartboard: "Operator1/Tasks"
type: Project
status: "Active"
priority: high
assignee: "rohit sharma"
tags: [process, upstream, sync, git]
startAt:
dueAt:
dart_project_id:
# -------------------------------------------------------------------------------
---

# Upstream Selective Sync Process

**Created:** 2026-03-13
**Status:** Active
**Replaces:** Full `git merge upstream/main` approach

---

## 1. Overview

Operator1 has diverged significantly from upstream openclaw (135+ custom
commits covering SQLite migration, commands system, memory improvements,
hub concept, UI changes). Full upstream merges are no longer practical —
they pull in hundreds of unwanted refactors, cause widespread conflicts,
and risk breaking operator1-specific systems.

This doc defines the **selective cherry-pick pipeline**: we decide what
comes in from upstream, not the other way around.

---

## 2. Principles

- **We choose what lands.** No change enters operator1 without explicit review.
- **Security fixes first.** Always prioritize security patches.
- **Cherry-pick on a sync branch, merge to main.** Never cherry-pick directly
  onto `main`. Use a short-lived `sync/<tag>` branch so you can abort cleanly
  if things go sideways mid-batch.
- **One sync branch per upstream release.** Keeps changes traceable.
  Exception: out-of-cycle security hotfixes use `sync/ghsa-<id>` or
  `sync/cve-<id>` naming.
- **Always `cherry-pick -x`.** The `-x` flag auto-appends
  `(cherry picked from commit <sha>)` to every commit message, giving free
  reverse-traceability from `git log` without relying on the sync log alone.
- **Test before merge.** Every cherry-pick batch is validated before landing on `main`.
- **Dry-run before commit.** Use `--no-commit` cherry-picks to catch missing
  dependencies early without polluting history.

---

## 3. Git Topology

### Phased PR Workflow (default)

Each upstream release is synced in **per-category phases**, each with its own
branch and PR. This keeps PRs focused and reviewable.

```
upstream/main (pure openclaw — fetch only, never push)
  │
  │  identify commits, classify into 6 categories
  │
  ▼
Phase 1: sync/<tag>-security ──── PR → merge to main → user tests
Phase 2: sync/<tag>-bugfixes ──── PR → merge to main → user tests
Phase 3: sync/<tag>-features ──── PR → merge to main → user tests
Phase 4: sync/<tag>-provider-refactor ── PR → merge to main → user tests
Phase 5: sync/<tag>-review ────── PR → merge to main → user tests
Phase 6: sync/<tag>-ui-inspiration ──── draft PR (reference only)
  │
  ▼
origin/main (operator1) — each phase branches from main AFTER prior phase merges
```

**Key:** Each phase branches from the current `main` (which includes all prior
phases' merged commits). The user does hands-on testing after each merge before
the next phase starts. This catches regressions early and keeps the sync
reversible at each step.

### Phase categories

| Phase | Category          | Branch Pattern                 | Priority                         |
| ----- | ----------------- | ------------------------------ | -------------------------------- |
| 1     | Security          | `sync/<tag>-security`          | Critical — merge first           |
| 2     | Bug Fixes         | `sync/<tag>-bugfixes`          | High                             |
| 3     | Features          | `sync/<tag>-features`          | Medium                           |
| 4     | Provider/Refactor | `sync/<tag>-provider-refactor` | Align with upstream architecture |
| 5     | Review Items      | `sync/<tag>-review`            | Triaged during classification    |
| 6     | UI Inspiration    | `sync/<tag>-ui-inspiration`    | Reference — draft PR             |

### Legacy single-branch workflow

For small syncs (< 20 commits) or hotfixes, a single `sync/<tag>` branch
with one PR is still acceptable.

### One-time setup: Disable push to upstream

Prevent accidental pushes to the real openclaw repo:

```bash
git remote set-url --push upstream FETCH_ONLY_NO_PUSH
```

This makes any `git push upstream` fail with a clear error. Verify with
`git remote -v` — push URL should show `FETCH_ONLY_NO_PUSH`.

---

## 4. Change Classification

Every upstream change falls into one of four buckets:

| Bucket       | Priority | Action                                                | SLA                  |
| ------------ | -------- | ----------------------------------------------------- | -------------------- |
| **Security** | Critical | Cherry-pick immediately                               | Same day             |
| **Bug fix**  | High     | Cherry-pick if we're affected or likely to be         | Within release cycle |
| **Feature**  | Medium   | Evaluate — adopt, adapt, or skip                      | Per-release review   |
| **Refactor** | Low      | Usually skip unless it unblocks a fix/feature we want | Skip by default      |

### How to classify

1. Read upstream `CHANGELOG.md` diff between our last synced tag and the target
2. Check upstream GitHub releases for highlighted security/breaking changes
3. For each entry, ask:
   - Does this fix a bug we've seen or could hit? → **Bug fix**
   - Does this address a security advisory? → **Security**
   - Does this add something we want? → **Feature**
   - Is this restructuring code we've already modified? → **Refactor** (skip)

---

## 5. Step-by-Step Process

### Phase 1: Identify (30 min)

```bash
# 1. Fetch upstream
git fetch upstream --tags

# 2. Find our last synced tag
# Always use the sync log (§7) as ground truth — NOT git merge-base.
# merge-base is unreliable for cherry-pick workflows (returns old
# historical commits, not the actual sync point).
# Example: sync log says v2026.3.8 → that's your base.

# 3. Identify target release
git tag -l 'v20*' --sort=-version:refname | grep -v beta | head -5

# 4. Read the changelog diff
git diff v2026.3.8..v2026.3.12 -- CHANGELOG.md

# 5. List commits between releases
git log --oneline v2026.3.8..v2026.3.12 --no-merges | wc -l
git log --oneline v2026.3.8..v2026.3.12 --no-merges
```

### Phase 2: Review & Select (1-2 hrs for large releases)

**Pre-filter by scope:** Before reviewing individual commits, narrow down
to files you care about. This cuts hundreds of commits to a manageable set.

> **Maintenance note:** Update this path list whenever operator1 adds new
> top-level source directories or renames existing ones. A stale filter
> silently misses commits in new areas.

```bash
# Only show commits touching areas we use
git log --oneline v2026.3.8..v2026.3.12 --no-merges -- \
  src/agents/ src/auto-reply/ src/gateway/ extensions/ \
  src/infra/ src/media/ src/channels/ src/routing/
```

For each CHANGELOG entry or commit of interest:

```bash
# Find the commit(s) for a specific fix
git log upstream/main --oneline --grep="WebSocket reconnect"

# View the full diff of a commit
git show <sha> --stat    # files changed
git show <sha>           # full diff

# Check if it touches files we've heavily modified
git show <sha> --stat | grep -f <(echo -e "system-prompt.ts\ncommands-core.ts\nstate-db/schema.ts")

# Detect dependency chains: check if a target commit depends on
# something we're skipping (does the target sit downstream of the skip?)
git log --oneline --ancestry-path <skipped-sha>..<target-sha>
# If output is non-empty, the target depends on the skipped commit.
# Options: cherry-pick the chain, adapt manually, or defer.
```

Classify each into the sync log (see §7).

### Phase 3: Cherry-pick onto sync branch

```bash
# Create a sync branch from main
git checkout main
git checkout -b sync/v2026.3.12

# Batch dry-run: cherry-pick ALL selected commits without committing,
# then build to catch missing deps / interaction effects across the batch.
git cherry-pick --no-commit <sha1> <sha2> <sha3>
pnpm build  # does it compile? if not, you're missing a dependency commit
git reset --hard  # discard dry-run working tree (sync branch only, safe)

# Now cherry-pick for real (chronological order).
# Always use -x to record the source SHA in the commit message.
git cherry-pick -x <sha1>
# → if conflict: resolve, then git cherry-pick --continue
# → if too messy: git cherry-pick --abort and skip
git cherry-pick -x <sha2>
git cherry-pick -x <sha3>

# If a cherry-pick depends on a commit we skipped, either:
#   a) cherry-pick the dependency too
#   b) adapt the fix manually (write our own version)
#   c) skip and note in sync log

# If a cherry-pick touches package.json, always regenerate the lockfile:
pnpm install
git add pnpm-lock.yaml
git commit -m "chore: regenerate lockfile after upstream cherry-pick"
# Never try to resolve lockfile merge conflicts manually — just regenerate.
```

**Abort escape hatch:** If the batch is going badly mid-way:

```bash
git cherry-pick --abort        # cancel in-progress cherry-pick
git checkout main              # back to safety
git branch -D sync/v2026.3.12  # delete the failed sync branch
# main is completely untouched
```

### Phase 4: Validate & Merge to main

```bash
# Still on sync/v2026.3.12
pnpm install && pnpm build && pnpm test
cd ui-next && pnpm build && cd ..

# Optional but recommended: push sync branch to run CI before merging.
# Catches environment-specific failures (Node version, etc.).
git push -u origin sync/v2026.3.12

# If all good, fast-forward merge to main
git checkout main
git merge --ff-only sync/v2026.3.12

# If fast-forward fails (main moved), rebase sync branch first:
# git checkout sync/v2026.3.12
# git rebase main
# <re-validate: pnpm build && pnpm test>
# IMPORTANT: rebase rewrites SHAs — update sync log entries if you
# recorded cherry-pick SHAs there. The -x trailer still has the
# original upstream SHA, but the operator1 commit SHA changes.
# git checkout main
# git merge --ff-only sync/v2026.3.12

git push
git branch -d sync/v2026.3.12
git push origin --delete sync/v2026.3.12 2>/dev/null  # clean up remote

# Update the sync log in this doc
# Run the cherry-pick post-sync checklist (§7.1)
```

### Phase 5: Rollback (if needed)

If a cherry-picked commit causes a regression after push:

```bash
# Revert creates a new commit — safe for shared branches
git revert <cherry-picked-sha>
git push

# Note the revert in the sync log with reason
```

Never use `git reset --hard` or force-push to undo cherry-picks on `main`.

---

## 6. What to Watch For

### Files we've heavily modified (conflict-prone)

These files have significant operator1 customizations. Cherry-picks touching
them need extra care:

| File                                     | Conflict strategy                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/system-prompt.ts`            | Take theirs for new prompt logic, keep our custom sections intact. Merge by appending upstream additions around our blocks.                                                                                                                                                                                          |
| `src/auto-reply/reply/commands-core.ts`  | Keep our handler pipeline order. Take theirs for new command registrations only.                                                                                                                                                                                                                                     |
| `src/gateway/server-methods.ts`          | Append-only — take theirs for new handlers, keep ours. Both sides should coexist.                                                                                                                                                                                                                                    |
| `src/gateway/server-methods-list.ts`     | Append-only — merge both method lists.                                                                                                                                                                                                                                                                               |
| `src/gateway/method-scopes.ts`           | Append-only — merge both scope entries.                                                                                                                                                                                                                                                                              |
| `src/gateway/protocol/schema/*.ts`       | Take theirs for new types. Keep our custom types. If same type modified, manual merge.                                                                                                                                                                                                                               |
| `src/infra/state-db/schema.ts`           | **Our version always wins on migration number.** If upstream adds a migration at the same number as ours: take their table/column logic, renumber it to our next available migration number, and update the version constant. Never squash upstream + ours into one migration — keep them separate for auditability. |
| `ui-next/src/app.tsx`                    | Keep our custom routes. Take theirs for shared component updates only.                                                                                                                                                                                                                                               |
| `ui-next/src/components/app-sidebar.tsx` | Keep our custom navigation. Manual merge if both sides modify.                                                                                                                                                                                                                                                       |

### Files safe to cherry-pick freely

These are less likely to conflict — **but verify before each sync** from both
sides: (a) did we modify a "safe" file locally, and (b) does the incoming
cherry-pick touch a file we've diverged on?

```bash
# Check 1: which "safe" files have we locally touched since last sync?
LAST_SYNC_TAG="v2026.3.8"  # update from sync log §7
for path in \
  "src/agents/tools/" \
  "src/agents/model-*.ts" \
  "src/agents/pi-embedded-helpers/errors.ts" \
  "src/agents/openai-ws-connection.ts" \
  "extensions/" \
  "docs/"; do
  count=$(git log --oneline "$LAST_SYNC_TAG"..HEAD -- "$path" 2>/dev/null | wc -l | tr -d ' ')
  [ "$count" -gt 0 ] && echo "LOCAL: $path has $count local commits since $LAST_SYNC_TAG"
done

# Check 2: does a specific cherry-pick target touch files we've diverged on?
# Run per-commit before picking from the "safe" list.
git show --stat <sha> --name-only | while read -r file; do
  [ -z "$file" ] && continue
  local_changes=$(git log --oneline "$LAST_SYNC_TAG"..HEAD -- "$file" 2>/dev/null | wc -l | tr -d ' ')
  [ "$local_changes" -gt 0 ] && echo "CONFLICT RISK: $file has $local_changes local changes"
done
```

Default safe list (subject to the check above):

- `src/agents/tools/*` — individual tool implementations
- `src/agents/model-*.ts` — model definitions, forward-compat
- `src/agents/pi-embedded-helpers/errors.ts` — error classification
- `src/agents/openai-ws-connection.ts` — WebSocket management
- `extensions/*` — plugin code (we generally don't modify these)
- `docs/*` — documentation (we maintain separately)

### Security advisories

- Watch: https://github.com/openclaw/openclaw/security/advisories
- Also check commits tagged with `fix:` + `security`, `GHSA`, `CVE`, `XSS`, `injection`

---

## 7. Sync Log

Track every sync decision here. One section per upstream release reviewed.

**Cumulative skipped: 0** _(update after each review — triggers full merge
consideration at > 500; see §8)_

### 7.1 Cherry-pick Post-Sync Checklist

Run after every cherry-pick sync lands on main (abbreviated from the full
merge checklist — only items relevant to partial syncs):

- [ ] `pnpm build` passes
- [ ] `pnpm test` passes
- [ ] `cd ui-next && pnpm build` passes
- [ ] If cherry-pick touched `src/gateway/server-methods*.ts`: verify all
      handlers imported AND spread into `coreGatewayHandlers`
- [ ] If cherry-pick touched `src/gateway/server-methods-list.ts`: verify
      every method name in `BASE_METHODS`
- [ ] If cherry-pick touched `src/gateway/method-scopes.ts`: verify every
      method has a scope entry
- [ ] If cherry-pick touched `package.json` exports: verify all
      `./plugin-sdk/*` subpath exports present
- [ ] Sync log updated with adopted/skipped/deferred decisions
- [ ] Cumulative skipped count updated

---

### Last synced to: v2026.3.8 (2026-03-09)

Full merge — last time we did a complete upstream sync.

---

### v2026.3.11 (2026-03-12) — 235 commits

**Status:** Pending review

> **Note:** Review v2026.3.11 before v2026.3.12. If a v2026.3.12 commit
> depends on a v2026.3.11 commit you skipped, you must either pick the
> dependency from v2026.3.11 first or defer the v2026.3.12 commit.
> Process sequentially: create `sync/v2026.3.11`, merge, then
> `sync/v2026.3.12`.

#### Adopted

_(none yet — review needed)_

#### Skipped

_(none yet — review needed)_

#### Deferred

_(none yet — review needed)_

---

### v2026.3.12 (2026-03-13) — 197 additional commits since v2026.3.11

Verify delta: `git log --oneline v2026.3.11..v2026.3.12 --no-merges | wc -l`

**Status:** Pending review — review only after v2026.3.11 is resolved.

#### Adopted

_(none yet — review needed)_

#### Skipped

_(none yet — review needed)_

#### Deferred

_(none yet — review needed)_

---

## 8. When to Do a Full Merge Instead

If **any** of these hard triggers fire, consider a full merge as a "rebase checkpoint":

- **Cumulative skipped commits > 500.** Too much drift — cherry-picking becomes
  a game of whack-a-mole with implicit dependencies.
- **Same dependency chain deferred 3+ times.** If you keep punting the same
  prerequisite commits, the upstream codebase has structurally moved on.
- **Upstream ships a foundational change we need** (e.g., new SDK version,
  major dependency bump, new build system).
- **Cherry-pick burden per release consistently exceeds 4 hours.** At that
  point you're doing a merge with extra steps and worse traceability.

Additional context factors (weigh alongside the triggers above):

- We're 5+ stable releases behind
- We have time for a dedicated sync sprint (2-3 days)

Use the sync-lead/code-guard/qa-runner agents for full merges. Always on a
dedicated branch, never directly on `main`.

---

## 9. FAQ

**Q: Won't we fall behind on important upstream improvements?**
A: We review every release. Important fixes get cherry-picked. Features we
don't need are intentionally skipped. This is a feature, not a bug.

**Q: What if an upstream fix depends on a refactor we skipped?**
A: Either cherry-pick the dependency chain, or adapt the fix to work with
our codebase. If the dependency chain is too large, defer and flag it.

**Q: How often should we review upstream?**
A: Every stable release (roughly weekly). Security advisories: immediately.

**Q: Can we automate any of this?**
A: The identify phase (CHANGELOG diff, commit listing) can be scripted.
The classification and cherry-pick decisions are human/AI judgment calls.
Consider a weekly cron/Dart task that fetches upstream tags, compares to the
sync log, and creates a review task with commit count + changelog diff when
a new stable release appears.

**Q: How do I handle upstream dependency bumps?**
A: If a cherry-pick touches `package.json`, never try to resolve `pnpm-lock.yaml`
conflicts manually. Cherry-pick the `package.json` change, run `pnpm install` to
regenerate the lockfile, and commit the result separately.

---

## 10. References

- Previous sync process: sync-lead/code-guard/qa-runner agents (still available for full merges)
- Upstream repo: https://github.com/openclaw/openclaw
- Cherry-pick post-sync checklist: §7.1 (inline above)
- Full merge post-sync checklist: see MEMORY.md "Post-Upstream-Sync Checklist"
- Key source files:
  - `src/gateway/server-methods.ts` — handler registry (append-only)
  - `src/gateway/server-methods-list.ts` — method names (append-only)
  - `src/gateway/method-scopes.ts` — scope registry (append-only)

---

_Process version: 3.0 — 2026-03-16 (phased PR workflow: per-category branches/PRs, 6-phase pipeline with human-in-the-loop testing between phases, provider refactor + UI inspiration phases, sync-state.json currentSync tracking, resume capability)_
