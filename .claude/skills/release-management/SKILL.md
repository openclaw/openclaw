---
name: release-management
description: Manages release builds, hotfix application, and deployment workflows for Clawdbot. Use when building releases, checking release status, applying hotfixes, deploying versions, or discussing release processes.
allowed-tools: Bash(git:*), Bash(./scripts/*:*), Read, Grep, Glob
---

# Release Management

Expert guidance for building, deploying, and managing Clawdbot releases with hotfixes.

## Core Concepts

### Release Workflow
Clawdbot uses a fork-based workflow with upstream synchronization:
1. **Upstream** releases are tagged versions from the main Claude Code repository
2. **Hotfixes** are maintained in `hotfix/*` branches in the fork
3. **Builds** are created in `.worktrees/<version>` with hotfixes auto-applied

### Worktree Structure
- Main repo: Current development branch
- `.worktrees/v2026.1.x/`: Built release with hotfixes
- Each worktree is independent, allowing parallel versions

## Key Scripts

### `scripts/release-fixes-status.sh`
Shows current hotfix branches and their merge status.

**When to use:** Check before building to see what fixes will be applied.

### `scripts/build-release.sh <version>`
Creates a worktree for the specified version and applies all hotfixes.

**When to use:** After confirming the target version and hotfixes.

**Safety checks:**
- Verifies git state is clean
- Creates isolated worktree
- Auto-applies hotfixes
- Reports success/failure

## Common Workflows

### Building Latest Release

Use the `/build-release` command:
```
/build-release
```

Or specify a version:
```
/build-release v2026.1.8
```

Unattended mode (no prompts):
```
/build-release -y
```

### Checking Release Status

1. **Show hotfixes:**
   ```bash
   ./scripts/release-fixes-status.sh
   ```

2. **List available releases:**
   ```bash
   git tag --sort=-version:refname | grep '^v2' | head -10
   ```

3. **Check worktrees:**
   ```bash
   git worktree list
   ```

### Creating a New Hotfix

1. **Create branch from upstream tag:**
   ```bash
   git checkout -b hotfix/fix-name v2026.1.x
   ```

2. **Apply fix and commit**

3. **Update status script if needed**

### Deploying a Build

After building, the worktree contains the deployable version:
- Location: `.worktrees/<version>/`
- All hotfixes are applied
- Ready for testing or deployment

## Safety Guidelines

### Pre-Build Checks
- ✓ No uncommitted changes in main repo
- ✓ Hotfix branches are up to date
- ✓ Target version exists upstream
- ✓ Sufficient disk space for worktree

### Multi-Agent Safety
- **Do not** delete worktrees without confirmation
- **Do not** modify hotfix branches unless explicitly requested
- **Do not** force-push to upstream
- **Keep** worktrees isolated from main development

### Version Naming
- Upstream versions: `v2026.1.x` (semantic versioning)
- Hotfix branches: `hotfix/descriptive-name`
- Worktrees: `.worktrees/v2026.1.x/`

## Best Practices

1. **Always check status before building**
   - Run `release-fixes-status.sh` first
   - Verify intended hotfixes will apply

2. **Use unattended mode for automation**
   - Add `-y` flag when using with `claude -p`
   - Ensures non-interactive execution

3. **Keep hotfixes focused**
   - One fix per branch when possible
   - Clear naming: `hotfix/fix-auth-bug`

4. **Test in worktree before deployment**
   - Each worktree is isolated
   - Safe to test without affecting main repo

## Troubleshooting

### Build Fails: Uncommitted Changes
**Error:** "Build blocked: You have uncommitted changes"

**Solution:**
```bash
git status  # Check what's changed
git stash   # Or commit changes
```

### Hotfix Won't Apply
**Error:** Merge conflict during build

**Solution:**
1. Check `release-fixes-status.sh` output
2. Manually test merge in worktree
3. Update hotfix branch to resolve conflicts

### Worktree Already Exists
**Error:** "Worktree exists: .worktrees/v2026.1.x"

**Solution:**
- Use existing worktree if it's current
- Remove and rebuild if outdated:
  ```bash
  git worktree remove .worktrees/v2026.1.x
  ./scripts/build-release.sh v2026.1.x
  ```

## Version Locations

When updating versions across the codebase:
- CLI: `package.json`
- Android: `apps/android/app/build.gradle.kts`
- iOS: `apps/ios/Sources/Info.plist`, `apps/ios/Tests/Info.plist`
- macOS: `apps/macos/Sources/Clawdbot/Resources/Info.plist`
- Docs: `docs/install/updating.md`

## Related Commands

- `/build-release` - Build latest or specific version
- Standard git commands for hotfix management
- Deployment scripts (project-specific)

## Progressive Loading

For detailed information on specific topics:
- Release process details: See `docs/` directory
- Build script internals: Read `scripts/build-release.sh`
- Hotfix patterns: Review existing `hotfix/*` branches
