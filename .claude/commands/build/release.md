---
description: Build latest upstream release with hotfixes applied
argument-hint: [version] [-y|--yes]
allowed-tools: Bash(git:*), Bash(./scripts/*:*), Read
hooks:
  PreToolUse:
    - matcher: "Bash(./scripts/build-release.sh:*)"
      hooks:
        - type: command
          command: "git diff --quiet && git diff --cached --quiet || exit 2"
          blocking: true
          errorMessage: "Build blocked: You have uncommitted changes. Commit or stash them first."
---

# Build Release

Build the latest upstream release with hotfixes applied.

## Arguments

- `version` - Optional: specific version to build (e.g., `v2026.1.8`). If not provided, builds latest.
- `-y` or `--yes` - Skip confirmation prompts for unattended execution (e.g., with `claude -p`)

## Steps

1. **Check hotfix status** - Show current `hotfix/*` branches and their status
2. **Check for new upstream release** - Fetch tags and compare with local
3. **Build** - Create worktree and build with hotfixes auto-applied

## Instructions

Run these steps in order:

### Step 1: Show hotfix status

Current hotfix status:
!`./scripts/release-fixes-status.sh`

### Step 2: Check for new upstream release

First, fetch latest tags:
!`git fetch upstream --tags 2>&1`

Latest upstream release:
!`git tag --sort=-version:refname | grep '^v2' | head -1`

Check if worktree exists:
!`LATEST=$(git tag --sort=-version:refname | grep '^v2' | head -1); if [[ -d ".worktrees/$LATEST" ]]; then echo "✓ Worktree exists: .worktrees/$LATEST"; else echo "✗ No worktree yet for $LATEST"; fi`

### Step 3: Confirm and build

**Parse arguments:**
- If `$ARGUMENTS` contains `-y` or `--yes`, skip confirmation (unattended mode)
- Extract version from arguments (if any, excluding flags)

**Confirmation logic:**
- If unattended mode (`-y` or `--yes`): proceed directly to build
- Otherwise: use AskUserQuestion to confirm before building

**Build command:**

Determine the version to build:
- If version specified in arguments: use that version
- Otherwise: use the latest tag from Step 2

Then execute:
```bash
./scripts/build-release.sh <version>
```

Where `<version>` is either the specified version or latest tag (e.g., `v2026.1.9`).

### Step 4: Report results

After build completes, show:
- Build location (`.worktrees/<version>`)
- Which hotfixes were applied
- Next steps (e.g., deployment command)
