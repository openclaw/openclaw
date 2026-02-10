---（轉為繁體中文）
description: Audit changelog entries before release（轉為繁體中文）
---（轉為繁體中文）
（轉為繁體中文）
Audit changelog entries for all commits since the last release.（轉為繁體中文）
（轉為繁體中文）
## Process（轉為繁體中文）
（轉為繁體中文）
1. **Find the last release tag:**（轉為繁體中文）
（轉為繁體中文）
   ```bash（轉為繁體中文）
   git tag --sort=-version:refname | head -1（轉為繁體中文）
   ```（轉為繁體中文）
（轉為繁體中文）
2. **List all commits since that tag:**（轉為繁體中文）
（轉為繁體中文）
   ```bash（轉為繁體中文）
   git log <tag>..HEAD --oneline（轉為繁體中文）
   ```（轉為繁體中文）
（轉為繁體中文）
3. **Read each package's [Unreleased] section:**（轉為繁體中文）
   - packages/ai/CHANGELOG.md（轉為繁體中文）
   - packages/tui/CHANGELOG.md（轉為繁體中文）
   - packages/coding-agent/CHANGELOG.md（轉為繁體中文）
（轉為繁體中文）
4. **For each commit, check:**（轉為繁體中文）
   - Skip: changelog updates, doc-only changes, release housekeeping（轉為繁體中文）
   - Determine which package(s) the commit affects (use `git show <hash> --stat`)（轉為繁體中文）
   - Verify a changelog entry exists in the affected package(s)（轉為繁體中文）
   - For external contributions (PRs), verify format: `Description ([#N](url) by [@user](url))`（轉為繁體中文）
（轉為繁體中文）
5. **Cross-package duplication rule:**（轉為繁體中文）
   Changes in `ai`, `agent` or `tui` that affect end users should be duplicated to `coding-agent` changelog, since coding-agent is the user-facing package that depends on them.（轉為繁體中文）
（轉為繁體中文）
6. **Add New Features section after changelog fixes:**（轉為繁體中文）
   - Insert a `### New Features` section at the start of `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md`.（轉為繁體中文）
   - Propose the top new features to the user for confirmation before writing them.（轉為繁體中文）
   - Link to relevant docs and sections whenever possible.（轉為繁體中文）
（轉為繁體中文）
7. **Report:**（轉為繁體中文）
   - List commits with missing entries（轉為繁體中文）
   - List entries that need cross-package duplication（轉為繁體中文）
   - Add any missing entries directly（轉為繁體中文）
（轉為繁體中文）
## Changelog Format Reference（轉為繁體中文）
（轉為繁體中文）
Sections (in order):（轉為繁體中文）
（轉為繁體中文）
- `### Breaking Changes` - API changes requiring migration（轉為繁體中文）
- `### Added` - New features（轉為繁體中文）
- `### Changed` - Changes to existing functionality（轉為繁體中文）
- `### Fixed` - Bug fixes（轉為繁體中文）
- `### Removed` - Removed features（轉為繁體中文）
（轉為繁體中文）
Attribution:（轉為繁體中文）
（轉為繁體中文）
- Internal: `Fixed foo ([#123](https://github.com/badlogic/pi-mono/issues/123))`（轉為繁體中文）
- External: `Added bar ([#456](https://github.com/badlogic/pi-mono/pull/456) by [@user](https://github.com/user))`（轉為繁體中文）
