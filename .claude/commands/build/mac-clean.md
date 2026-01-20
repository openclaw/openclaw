---
description: Build macOS companion app from upstream release without hotfixes
argument-hint: [version] [-y|--yes]
allowed-tools: Bash(git:*), Bash(./scripts/*:*), Read, AskUserQuestion
hooks:
  PreToolUse:
    - matcher: "Bash(./scripts/build-mac-clean.sh:*)"
      hooks:
        - type: command
          command: "git diff --quiet && git diff --cached --quiet || exit 2"
          blocking: true
          errorMessage: "Build blocked: You have uncommitted changes. Commit or stash them first."
---

# Build macOS Clean

Build the macOS companion app (Clawdbot.app) from a clean upstream release without any hotfixes applied.

**Note:** This builds the macOS app only - it does NOT build the CLI or other platforms.

## Arguments

- `version` - Optional: specific version to build (e.g., `v2026.1.8`). If not provided, builds latest.
- `-y` or `--yes` - Skip confirmation prompts for unattended execution (e.g., with `claude -p`)

## Steps

1. **Check for new upstream release** - Fetch tags and compare with local
2. **Build** - Create worktree at `.worktrees/latest` and build from clean tag (no hotfixes)

## Instructions

Run these steps in order:

### Step 1: Check for new upstream release

First, fetch latest tags:
!`git fetch upstream --tags 2>&1`

Latest upstream release:
!`git tag --sort=-version:refname | grep '^v2' | head -1`

Check if worktree exists:
!`LATEST=$(git tag --sort=-version:refname | grep '^v2' | head -1); if [[ -d ".worktrees/$LATEST" ]]; then echo "✓ Worktree exists: .worktrees/$LATEST"; else echo "✗ No worktree yet for $LATEST"; fi`

### Step 2: Confirm and build

**Parse arguments:**
- If `$ARGUMENTS` contains `-y` or `--yes`, skip confirmation (unattended mode)
- Extract version from arguments (if any, excluding flags)

**Confirmation logic:**
- If unattended mode (`-y` or `--yes`): proceed directly to build
- Otherwise: use AskUserQuestion to confirm before building

**Build command:**

Determine the version to build:
- If version specified in arguments: use that version
- Otherwise: use the latest tag from Step 1

Then execute:
```bash
./scripts/build-mac-clean.sh <version>
```

Where `<version>` is either the specified version or latest tag (e.g., `v2026.1.9`).

### Step 3: Report results

After build completes, show:
- Build location (`.worktrees/latest`)
- Note that this is a clean build (no hotfixes applied)
- Next steps (e.g., deployment command)
