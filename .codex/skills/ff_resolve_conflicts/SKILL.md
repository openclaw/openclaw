---
name: ff_resolve_conflicts
description: Resolve git merge or rebase conflicts interactively
---

# Resolve Merge Conflicts

You are tasked with helping resolve git merge or rebase conflicts in the current branch.

## Initial Assessment

When invoked, immediately check for conflicts:

1. **Detect conflict state:**

   ```bash
   git status --porcelain
   ```

   Look for files marked with `UU` (both modified), `AA` (both added), `DD` (both deleted), etc.

2. **Determine operation type:**
   - Check for `.git/MERGE_HEAD` → merge in progress
   - Check for `.git/rebase-merge/` or `.git/rebase-apply/` → rebase in progress
   - Neither → no conflict state (user may need to initiate merge/rebase first)

3. **If no conflicts detected:**

   ```
   No merge or rebase conflicts detected.

   To resolve conflicts, first initiate a merge or rebase:
   - Merge: `git merge <branch>`
   - Rebase: `git rebase <branch>`

   Then run this skill again when conflicts occur.
   ```

## Conflict Resolution Process

### Step 1: List Conflicted Files

```bash
git diff --name-only --diff-filter=U
```

Present the list clearly:

```
Found X conflicted file(s):
1. path/to/file1.go
2. path/to/file2.ts
...
```

### Step 2: Analyze Each Conflict

For each conflicted file:

1. **Read the file** to understand the conflict markers
2. **Identify the conflict regions** (marked by `<<<<<<<`, `=======`, `>>>>>>>`)
3. **Understand the changes:**
   - What's in HEAD (current branch)
   - What's in the incoming branch
4. **Determine resolution strategy:**
   - Keep ours (current branch)
   - Keep theirs (incoming branch)
   - Combine both changes
   - Custom resolution

### Step 3: Present Resolution Plan

Before making changes, present a clear plan:

```markdown
## Conflict Resolution Plan

### File: path/to/file.go

**Conflict 1** (lines X-Y):

- **Ours (current):** [description]
- **Theirs (incoming):** [description]
- **Recommended resolution:** [explanation]

**Conflict 2** (lines A-B):
...

Shall I proceed with this resolution? I'll edit the files to resolve conflicts.
```

### Step 4: Resolve Conflicts

After user confirmation (or proceeding with recommended resolutions):

1. **Edit each file** to remove conflict markers and apply resolution
2. **Stage resolved files:** `git add <file>`
3. **Verify no conflicts remain:** `git diff --name-only --diff-filter=U`

### Step 5: Complete the Operation

Based on operation type:

**For Merge:**

```bash
git commit
# Git will use the merge commit message template
```

**For Rebase:**

```bash
git rebase --continue
# May need to repeat if more commits have conflicts
```

## Important Guidelines

1. **Always show the conflict content** before proposing resolution
2. **Explain reasoning** for each resolution choice
3. **Preserve intentional changes** from both sides when possible
4. **Be conservative** - when unsure, ask the user which version to keep
5. **Handle binary files** by asking user which version to keep (can't merge)
6. **Check for remaining conflicts** after each file is resolved

## Quick Reference

**Detect conflicts:**

```bash
git status --porcelain | grep "^UU\|^AA\|^DD"
```

**List conflicted files:**

```bash
git diff --name-only --diff-filter=U
```

**Check operation type:**

```bash
[ -f .git/MERGE_HEAD ] && echo "merge" || ([ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]) && echo "rebase"
```

**Stage resolved file:**

```bash
git add <file>
```

**Complete merge:**

```bash
git commit
```

**Complete rebase:**

```bash
git rebase --continue
```

**Abort if needed:**

```bash
git merge --abort    # for merge
git rebase --abort   # for rebase
```
