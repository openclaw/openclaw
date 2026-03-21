# Worktree Branch Survival

Use this when you are working across multiple branches or worktrees and want to avoid "losing" changes.

Most lost-work incidents are not real data loss. They are state confusion.

## The Simple Model

There are three different truths:

1. Remote truth
- what GitHub has, like `origin/main`

2. Local truth
- what your local branch points to, like `main`

3. Runtime truth
- what code the live process is actually running

Those can all disagree.

## Where Changes Can Live

Changes usually live in one of four places:

1. Working tree
- uncommitted file edits
- these exist only in this checkout/worktree folder

2. Local commits
- committed on your machine
- not necessarily pushed yet

3. Remote branch
- pushed to GitHub
- not necessarily merged

4. Merged target branch
- landed in `main`
- not necessarily pulled locally
- not necessarily running live

## The Five Safety Questions

Before rebasing, deleting, merging, or restarting a runtime, answer these:

1. Am I on the branch I think I am on?
2. Do I have uncommitted changes?
3. Are my commits pushed?
4. Is this branch actually merged yet?
5. Is the runtime using this checkout, or another one?

If you cannot answer those quickly, stop and print proof first.

## Worktree Reality

Each worktree has:

- its own checked-out branch or commit
- its own files on disk
- its own uncommitted changes

Do not assume another worktree sees your uncommitted edits.

Do not assume a checkout you call "main" is actually on `main`.

## Safe Sequence Before Risky Git Operations

Run these before branch surgery:

```bash
git status
git branch --show-current
git log --oneline --decorate -n 5
git fetch origin
```

If you are about to delete or abandon a branch, also check:

```bash
git rev-parse HEAD
git rev-parse origin/$(git branch --show-current 2>/dev/null || true)
```

## What Usually Goes Wrong

These are the common footguns:

- committed locally, never pushed
- pushed to a feature branch, never merged
- merged remotely, but local `main` is stale
- local `main` updated, but the live runtime still launches from another checkout
- uncommitted edits exist only in one worktree and get forgotten

## Proof Lines

When branch state matters, print:

- `branch=<branch>`
- `worktree=<path>`
- `head=<sha>`
- `status_dirty=yes|no`

When runtime state matters, also print:

- `runtime_worktree=<path>`
- `runtime_commit=<sha>`
- `runtime_command=<command>`
- `runtime_pid=<pid>`

That turns guesswork into evidence.

## Branch Delete Rule

Before deleting a branch, verify:

- it is merged or intentionally being abandoned
- there are no unpushed commits you still need
- no worktree still depends on it

If you are not sure, do not delete it yet.

## Main Rule

Do not say "done" just because:

- the branch is committed
- or the PR is open
- or GitHub says merged

For live systems, done means:

- merged to remote target branch
- local target branch updated
- runtime checkout verified
- runtime restarted
- proof printed

That is the full chain.
