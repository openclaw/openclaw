---
description: Audit changelog entries before release
---

Audit changelog entries for all commits since the last release.

## Process

1. **Find the last release tag:**

   ```bash
   git tag --sort=-version:refname | head -1
   ```

2. **List all commits since that tag:**

   ```bash
   git log <tag>..HEAD --oneline
   ```

3. **Read each package's [Unreleased] section:**
   - packages/ai/CHANGELOG.md
   - packages/tui/CHANGELOG.md
   - packages/coding-agent/CHANGELOG.md

4. **For each commit, check:**
   - Skip: changelog updates, doc-only changes, release housekeeping
   - Determine which package(s) the commit affects (use `git show <hash> --stat`)
   - Verify a changelog entry exists in the affected package(s)
   - For external contributions (PRs), verify format: `Description ([#N](url) by [@user](url))`

5. **Cross-package duplication rule:**
   Changes in `ai`, `agent` or `tui` that affect end users should be duplicated to `coding-agent` changelog, since coding-agent is the user-facing package that depends on them.

6. **Add New Features section after changelog fixes:**
   - Insert a `### New Features` section at the start of `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md`.
   - Propose the top new features to the user for confirmation before writing them.
   - Link to relevant docs and sections whenever possible.

7. **Report:**
   - List commits with missing entries
   - List entries that need cross-package duplication
   - Add any missing entries directly

## Changelog Format Reference

Sections (in order):

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

Attribution:

- Internal: `Fixed foo ([#123](https://github.com/badlogic/pi-mono/issues/123))`
- External: `Added bar ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@user](https://github.com/user))`
