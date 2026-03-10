# Local Codex Fork-Style Clone Design

## Goal

Create a local clone of `https://github.com/OpenKnots/codex` at
`~/Documents/GitHub/OpenKnots/codex` without installing dependencies, and
configure it in a fork-style layout so the current upstream repository is stored
as the `upstream` remote.

## Context

- The target parent directory `~/Documents/GitHub/OpenKnots` already exists.
- The target path `~/Documents/GitHub/OpenKnots/codex` does not exist yet.
- The upstream repository is reachable.
- The upstream default branch is `main`.

## Approaches Considered

### 1. Clone then rename remote

Run a normal `git clone`, then rename `origin` to `upstream`.

Pros:

- Standard and easy to verify.
- Keeps each action explicit.
- Minimizes surprise if any step fails.

Cons:

- One extra command compared with a custom clone remote name.

### 2. Clone with a custom remote name

Run `git clone --origin upstream ...`.

Pros:

- Slightly shorter.

Cons:

- Less familiar.
- Slightly harder to debug if setup needs correction later.

### 3. Manual repository initialization

Create the repository with `git init`, add remotes, fetch, and check out
`main`.

Pros:

- Maximum control.

Cons:

- Unnecessary ceremony for this task.

## Chosen Design

Use approach 1.

1. Clone `https://github.com/OpenKnots/codex` into
   `~/Documents/GitHub/OpenKnots/codex`.
2. Rename the clone's `origin` remote to `upstream`.
3. Verify that the checked out branch is `main`.
4. Verify that `git remote -v` shows only `upstream`.

## Error Handling

- If the target directory appears before cloning starts, stop and report rather
  than merging with existing contents.
- If the clone fails, do not retry with alternate flags automatically.
- If the remote rename fails, stop and report the repository state exactly as
  observed.

## Validation

- `git -C ~/Documents/GitHub/OpenKnots/codex branch --show-current`
  should return `main`.
- `git -C ~/Documents/GitHub/OpenKnots/codex remote -v`
  should show `upstream` for fetch and push URLs.
