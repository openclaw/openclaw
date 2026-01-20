# Build Commands

Show available build-related commands.

## Instructions

Display this help information to the user:

---

## Build Commands

| Command | Description |
|---------|-------------|
| `/build:mac-release [version]` | Build latest (or specific) macOS release with hotfixes |
| `/build:mac-clean [version]` | Build latest (or specific) macOS release without hotfixes |
| `/build:help` | Show this help |

## Hotfix Workflow

Hotfixes are automatically applied during builds. Use the `hotfix/` branch prefix:

```bash
# Create a hotfix
git checkout -b hotfix/my-fix
# ... make changes, commit ...

# Check status
./scripts/release-fixes-status.sh

# Build (hotfixes auto-apply)
/build:mac-release
```

## Scripts

| Script | Purpose |
|--------|---------|
| `./scripts/build-mac-release.sh <version>` | Build macOS app from release with hotfixes |
| `./scripts/build-mac-clean.sh <version>` | Build macOS app from release without hotfixes |
| `./scripts/deploy-release.sh [path]` | Deploy macOS app to /Applications (requires sudo) |
| `./scripts/release-fixes-status.sh [target]` | Show hotfix status |
| `./scripts/apply-release-fixes.sh [--dry-run]` | Apply hotfixes manually |
| `./scripts/rebase-hotfixes.sh [target]` | Rebase hotfix branches onto target release |

## Build Artifacts

- **Worktrees**: `.worktrees/latest/` - isolated build directory
- **Latest symlink**: `.local/latest` → most recent build
- **Built app**: `.worktrees/latest/dist/Clawdbot.app`

## How Hotfixes Work

1. Name your branch `hotfix/<name>`
2. Build script auto-detects all `hotfix/*` branches
3. Compares each against target version
4. Cherry-picks only commits not already in target
5. Once merged upstream, automatically skipped

---
