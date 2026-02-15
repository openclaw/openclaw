# Fork Sync Workflow

Comprehensive skill for managing the OpenClaw fork workflow, syncing with upstream, and updating all development branches.

## Critical Principle: Main is a Clean Mirror

**IMPORTANT**: The `main` branch must ALWAYS be a clean mirror of `upstream/main`. It should NEVER contain custom commits.

### Workflow for Custom Changes

When `main` has diverged from upstream (contains custom commits):

1. **Verify custom commits are on DEV/PRD**: Check that all custom work exists on development branches
2. **Reset main to upstream**: `git reset --hard upstream/main`
3. **Force push main**: `git push --force-with-lease origin main`
4. **Custom work remains safe**: All custom commits stay on DEV/PRD/feature branches

### Detection and Resolution

```bash
# Check if main has diverged
git fetch upstream
git log --oneline upstream/main..main

# If output shows commits (main has diverged):
# 1. Verify commits are on DEV/PRD
git log --oneline DEV | head -20
git log --oneline PRD | head -20

# 2. Reset main to upstream
git checkout main
git reset --hard upstream/main
git push --force-with-lease origin main
```

## Branch Structure

This fork maintains a specific branch hierarchy:

```
upstream/main (source of truth)
    ↓
main (clean mirror - NO custom commits)
    ↓
DEV (integration branch: main + all custom work)
    ↓
PRD (production-ready: mirrors DEV after validation)
```

### Branch Purposes

- **main**: Clean mirror of upstream/main, NEVER contains custom work
- **DEV**: Integration branch containing all custom features, used for testing
- **PRD**: Production-ready branch, mirrors DEV after validation

## Core Workflow

### Phase 0: Clean Main (if needed)

**Goal**: Ensure main is a clean mirror of upstream

```bash
# Check if main has diverged
git checkout main
git fetch upstream
git log --oneline upstream/main..main

# If commits shown, main has diverged - fix it:
# 1. Verify custom commits exist on DEV/PRD
git log --oneline DEV | grep "CustomCommit"
git log --oneline PRD | grep "CustomCommit"

# 2. Reset main to upstream
git reset --hard upstream/main
git push --force-with-lease origin main
```

**When to run**: Any time main has custom commits (detected by divergence check)

### Phase 1: Sync Main with Upstream

**Goal**: Update local main to match upstream/main

```bash
# Fetch latest from upstream
git fetch upstream

# Switch to main (should already be clean)
git checkout main

# Fast-forward merge upstream changes (should succeed now)
git merge --ff-only upstream/main

# Push to fork
git push origin main
```

**Expected**: Fast-forward merge, no conflicts (since main is clean mirror)

### Phase 2: Update DEV Branch

**Goal**: Merge updated main into DEV (bringing in upstream changes)

```bash
git checkout DEV

# Merge updated main
git merge main -m "Merge upstream changes from main"

# Resolve conflicts if any
# Push to origin
git push origin DEV
```

**Expected**: Clean merge or minor conflicts (DEV has custom commits + upstream changes)

### Phase 3: Update PRD Branch

**Goal**: Sync PRD with DEV (after validation)

```bash
git checkout PRD

# Merge updated DEV
git merge DEV -m "Sync PRD with DEV"

# Push to origin
git push origin PRD
```

**Expected**: Clean merge, PRD mirrors DEV

## Safety Checks

### Pre-Sync Checklist

Before starting the sync workflow:

- [ ] Working directory is clean (`git status`)
- [ ] No uncommitted changes that could conflict
- [ ] Upstream remote is configured (`git remote -v | grep upstream`)
- [ ] Latest upstream fetched (`git fetch upstream`)
- [ ] Main is clean mirror (no divergence from upstream)

### Verification Commands

After completing sync:

```bash
# Verify main matches upstream
git log --oneline main..upstream/main  # Should be empty

# Verify branch relationships
git log --oneline --graph --all --decorate -20

# Verify DEV contains main's commits
git merge-base --is-ancestor main DEV && echo "✓ DEV contains main" || echo "✗ DEV missing main commits"

# Verify PRD contains DEV's commits
git merge-base --is-ancestor DEV PRD && echo "✓ PRD contains DEV" || echo "✗ PRD missing DEV commits"
```

### Post-Sync Checklist

- [ ] `main` matches `upstream/main` (no divergence)
- [ ] `main` pushed to `origin/main`
- [ ] `DEV` merged main successfully
- [ ] `PRD` merged DEV successfully
- [ ] All branches pushed to remote
- [ ] Docker workflows still functional (images building successfully)

## Conflict Resolution

### Main Has Custom Commits

**Problem**: `git merge --ff-only upstream/main` fails with "Not possible to fast-forward"

**Root Cause**: Main contains custom commits (violates clean mirror principle)

**Solution**:
1. Verify custom commits exist on DEV/PRD: `git log --oneline DEV | head`
2. Reset main to upstream: `git reset --hard upstream/main`
3. Force push: `git push --force-with-lease origin main`
4. Continue normal workflow (merge main → DEV → PRD)

### Merge Conflicts in DEV

If conflicts occur when merging main into DEV:

1. **Identify conflicts**: `git status` shows conflicted files
2. **Common conflict areas**:
   - Docker configurations (if upstream changed docker-compose.yml)
   - Workflow files (if upstream changed .github/workflows/*)
   - Core files modified by both upstream and custom work

3. **Resolve manually**:
   - Keep custom Docker configurations from DEV
   - Integrate upstream improvements
   - Test after resolving

4. **Complete merge**:
   ```bash
   git add <resolved-files>
   git commit -m "Merge upstream changes, resolve conflicts"
   git push origin DEV
   ```

### Abort/Rollback

If issues occur during merge:

```bash
# Abort current merge
git merge --abort

# Reset to previous state
git reflog  # Find previous commit
git reset --hard HEAD@{1}

# Or restore from remote
git reset --hard origin/<branch-name>
```

## Common Scenarios

### Scenario 1: Regular Upstream Sync (Weekly/Bi-weekly)

When upstream has new commits and you want to pull them in:

1. **Phase 0**: Check if main is clean (should be)
2. **Phase 1**: Merge upstream/main → main (fast-forward)
3. **Phase 2**: Merge main → DEV
4. **Phase 3**: Merge DEV → PRD
5. **Time**: ~5-10 minutes

### Scenario 2: Main Has Diverged

When main accidentally contains custom commits:

1. **Phase 0**: Verify commits on DEV/PRD, reset main to upstream
2. Continue with normal workflow
3. **Time**: ~2-3 minutes extra

### Scenario 3: Emergency Hotfix from Upstream

When upstream has a critical fix you need immediately:

1. Sync main (fast-forward)
2. Cherry-pick to DEV if urgent: `git cherry-pick <commit-sha>`
3. Or run full workflow if you have time

## Quick Sync Script

For routine syncs (assumes main is already clean):

```bash
#!/bin/bash
# Quick sync script

set -e  # Exit on error

echo "🔄 Starting fork sync workflow..."

# Fetch upstream
git fetch upstream

# Phase 1: Sync main
echo "📥 Phase 1: Syncing main with upstream..."
git checkout main
git merge --ff-only upstream/main
git push origin main

# Phase 2: Update DEV
echo "🔧 Phase 2: Updating DEV branch..."
git checkout DEV
git merge main -m "Merge upstream changes from main"
git push origin DEV

# Phase 3: Update PRD
echo "🚀 Phase 3: Updating PRD branch..."
git checkout PRD
git merge DEV -m "Sync PRD with DEV"
git push origin PRD

echo "✅ Fork sync complete!"
git log --oneline --graph --all --decorate -10
```

## Best Practices

1. **Keep main clean**: NEVER commit custom work to main
2. **All custom work on DEV**: Commit custom changes to DEV or feature branches
3. **Sync regularly**: Weekly or bi-weekly to avoid large merge conflicts
4. **Clean working directory**: Always start with `git status` showing clean
5. **Review upstream changes**: Use `git log main..upstream/main` before merging
6. **Test after sync**: Verify Docker images build successfully
7. **DEV before PRD**: Always test in DEV before updating PRD

## Troubleshooting

### "fatal: Not possible to fast-forward"

**Cause**: Main has custom commits (diverged from upstream)

**Fix**: Run Phase 0 (Clean Main) first

### "error: Your local changes would be overwritten"

**Cause**: Uncommitted changes in working directory

**Fix**:
```bash
git status  # Review changes
git stash   # Temporarily save changes
# Run sync workflow
git stash pop  # Restore changes after sync
```

### "Updates were rejected because the remote contains work"

**Cause**: Remote branch has commits not in local branch

**Fix**:
```bash
git pull --rebase origin <branch-name>
# Resolve conflicts if any
git push origin <branch-name>
```

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│                  Fork Sync Quick Reference                   │
├─────────────────────────────────────────────────────────────┤
│ 0. Clean main (if needed) → git checkout main              │
│                              git reset --hard upstream/main │
│                              git push --force-with-lease    │
├─────────────────────────────────────────────────────────────┤
│ 1. Sync main              → git checkout main               │
│                              git merge --ff-only upstream/main│
│                              git push origin main           │
├─────────────────────────────────────────────────────────────┤
│ 2. Update DEV             → git checkout DEV                │
│                              git merge main                 │
│                              git push origin DEV            │
├─────────────────────────────────────────────────────────────┤
│ 3. Update PRD             → git checkout PRD                │
│                              git merge DEV                  │
│                              git push origin PRD            │
├─────────────────────────────────────────────────────────────┤
│ Verify:                   → git log main..upstream/main     │
│                              (should be empty)              │
└─────────────────────────────────────────────────────────────┘
```

## When to Use This Skill

Invoke this skill when:

- "Sync with upstream"
- "Update fork from openclaw/openclaw"
- "Pull latest from upstream"
- "Update all branches"
- "Sync DEV and PRD"
- "Fork workflow" or "fork-sync"
- Before starting major feature work (to start from latest upstream)
- After seeing main has diverged from upstream

---

**Skill Version**: 2.0.0
**Last Updated**: 2026-02-02
**Maintained By**: Nikolas P. (NikolasP98)
