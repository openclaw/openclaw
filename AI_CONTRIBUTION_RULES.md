# AI Agent Contribution Rules for OpenClaw

**MANDATORY CHECKLIST - ALL CODE CONTRIBUTIONS**

This document establishes the rules that ALL AI agents must follow when contributing code to the OpenClaw repository. These rules are non-negotiable and must be followed for every PR.

## Pre-Commit Checklist

Before ANY commit is pushed to GitHub:

### 1. Local Testing (REQUIRED)

```bash
# Run in this exact order:
pnpm install --frozen-lockfile  # Ensure dependencies are up to date
pnpm build                       # Build the project
pnpm check                       # Format check + tsgo + lint
pnpm test                        # Run all tests
pnpm check:docs                  # Check docs formatting + linting + links
```

**Result**: All commands must pass with 0 errors before proceeding.

### 2. Code Formatting (REQUIRED)

```bash
pnpm format                      # Format TypeScript/JavaScript with oxfmt
pnpm format:docs                 # Format markdown files with oxfmt
```

**Never commit unformatted code.**

### 3. Documentation Standards (REQUIRED)

All markdown files must:

- ✅ Have blank lines before and after code fences
- ✅ Wrap URLs in angle brackets: `<https://example.com>`
- ✅ Have unique heading names (no duplicates in same file)
- ✅ Pass `pnpm lint:docs` with 0 errors
- ✅ Have no broken links (`pnpm docs:check-links`)

### 4. Git Commit Messages

Follow this format:

```
<type>: <short description>

<optional longer description>

Refs #<issue-number>
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

**Types**: `fix`, `feat`, `docs`, `refactor`, `test`, `chore`, `security`

**Examples**:

- `fix: Resolve Telegram polling bug by adding comprehensive diagnostics`
- `docs: Add Raspberry Pi troubleshooting guide`
- `feat: Add model validation script for AWS Bedrock`

## Pull Request Requirements (REQUIRED)

Every PR must include ALL of these sections from `.github/pull_request_template.md`:

### 1. Summary (REQUIRED)

```markdown
## Summary

- Problem: [What issue/bug exists?]
- Why it matters: [Impact on users]
- What changed: [Specific changes made]
- What did NOT change (scope boundary): [What was intentionally not modified]
```

### 2. Change Type (REQUIRED)

Select all that apply:

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

### 3. Scope (REQUIRED)

Select all touched areas:

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

### 4. Linked Issue/PR (REQUIRED)

```markdown
- Closes #<issue-number>
- Related #<issue-number>
```

### 5. User-visible / Behavior Changes (REQUIRED)

List all changes users will see. If none, write `None`.

### 6. Security Impact (REQUIRED - CRITICAL)

Answer ALL of these:

- New permissions/capabilities? (`Yes/No`)
- Secrets/tokens handling changed? (`Yes/No`)
- New/changed network calls? (`Yes/No`)
- Command/tool execution surface changed? (`Yes/No`)
- Data access scope changed? (`Yes/No`)
- If any `Yes`, explain risk + mitigation:

### 7. Repro + Verification (REQUIRED)

```markdown
### Environment

- OS: [e.g., Raspberry Pi OS Bookworm 64-bit]
- Runtime/container: [e.g., Node 22.12.0]
- Model/provider: [e.g., AWS Bedrock us-east-1 / Claude Opus 4.5]
- Integration/channel: [e.g., Telegram polling mode]
- Relevant config: [redacted config snippets]

### Steps

1. [Step 1]
2. [Step 2]
3. [Step 3]

### Expected

- [What should happen]

### Actual

- [What actually happened]
```

### 8. Evidence (REQUIRED)

Attach at least one:

- [ ] Failing test/log before + passing after
- [ ] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

### 9. Human Verification (REQUIRED - CRITICAL)

```markdown
## Human Verification

What you personally verified (not just CI), and how:

- Verified scenarios: [List what was tested]
- Edge cases checked: [List edge cases]
- What you did **not** verify: [Be honest about limitations]
```

**Note**: For AI-generated PRs, this section should document what the human operator tested after code generation.

### 10. AI-Assisted Disclosure (REQUIRED for AI PRs)

```markdown
## AI-Assisted Contribution

- [ ] This PR was generated with AI assistance (Claude Opus 4.6)
- Testing level: [untested / lightly tested / fully tested]
- AI understands the code: [Yes/No - brief explanation]
- Session logs: [Available upon request / Attached / Not available]
```

### 11. Compatibility / Migration (REQUIRED)

```markdown
- Backward compatible? (`Yes/No`)
- Config/env changes? (`Yes/No`)
- Migration needed? (`Yes/No`)
- If yes, exact upgrade steps: [List steps]
```

### 12. Failure Recovery (REQUIRED)

```markdown
## Failure Recovery (if this breaks)

- How to disable/revert this change quickly: [Steps]
- Files/config to restore: [List files]
- Known bad symptoms reviewers should watch for: [List symptoms]
```

### 13. Risks and Mitigations (REQUIRED)

```markdown
## Risks and Mitigations

- Risk: [Specific risk]
  - Mitigation: [How it's addressed]

[Add/remove entries as needed. If none, write `None`.]
```

## Code Quality Standards

### TypeScript/JavaScript

- **Formatter**: oxfmt (run `pnpm format`)
- **Linter**: oxlint with type-aware checking (run `pnpm lint`)
- **Max file size**: 500 lines (checked by `pnpm check:loc`)
- **Decorators**: Use legacy decorators for Control UI (`@state()`, `@property()`)
- **No console.log**: Use proper logger (pino)

### Markdown

- **Formatter**: oxfmt (run `pnpm format:docs`)
- **Linter**: markdownlint-cli2 (run `pnpm lint:docs`)
- **Config**: `.markdownlint-cli2.jsonc`
- **Common rules**:
  - MD031: Blank lines around code fences
  - MD034: No bare URLs (use `<URL>`)
  - MD024: No duplicate headings
  - MD013: Line length (disabled)

### Bash Scripts

- Must have proper error handling
- Must be executable: `chmod +x script.sh`
- Must have shebang: `#!/bin/bash`
- Must use `set -e` for fail-fast
- Must have usage/help text

## PR Submission Rules

### Before Opening PR

1. ✅ All tests pass locally
2. ✅ All formatting checks pass
3. ✅ All linting checks pass
4. ✅ Documentation is updated
5. ✅ Commit messages follow convention
6. ✅ PR description follows template (ALL sections)

### PR Size Limits

- **Ideal**: Under 500 lines changed
- **Maximum**: 5,000 lines (requires exceptional justification)
- **Multiple PRs**: Don't open batches of tiny PRs - group related changes

### PR Focus

**ONE PR = ONE TOPIC**

✅ **Good**:

- PR #1: Fix Telegram polling bug
- PR #2: Add Raspberry Pi documentation
- PR #3: Add model validation scripts

❌ **Bad**:

- PR #1: Fix Telegram bug + Add docs + Refactor auth + Update CI

### What NOT to Include

❌ New core skills (should go to ClawHub)
❌ Full-doc translations (deferred)
❌ Commercial service integrations (unless model providers)
❌ Wrapper channels without clear capability gap
❌ Heavy orchestration layers
❌ Unrelated bug fixes bundled together
❌ "While I'm here" changes outside PR scope

## CI/CD Requirements

All PRs must pass these checks:

### Required Checks

1. **check** - Format + tsgo + lint
2. **check-docs** - Docs format + lint + links
3. **no-tabs** - No tab characters
4. **secrets** - No leaked secrets
5. **test** - All unit tests pass
6. **build-artifacts** - Build succeeds
7. **protocol** - Protocol checks pass

### Platform Checks (may be skipped)

- **ios** - iOS build
- **macos** - macOS build
- **android** - Android build

**All required checks must be GREEN before merging.**

## File Organization

### New Scripts

- **Validation scripts**: `scripts/doctor/<name>.sh`
- **Troubleshooting scripts**: `scripts/troubleshooting/<name>.sh`
- **Build scripts**: `scripts/<name>.mjs` or `scripts/<name>.ts`
- **Test scripts**: `test/<category>/<name>.test.ts`

### New Documentation

- **Guides**: `docs/<category>/<name>.md`
- **Troubleshooting**: `docs/troubleshooting/<name>.md`
- **Platform-specific**: `docs/platforms/<platform>.md`
- **Provider guides**: `docs/providers/<provider>.md`
- **Channel guides**: `docs/channels/<channel>.md`

### Naming Conventions

- **Scripts**: kebab-case (`validate-config.sh`)
- **TypeScript**: camelCase for functions, PascalCase for classes
- **Constants**: UPPER_SNAKE_CASE
- **Files**: kebab-case for multi-word files

## Security Rules

### NEVER Commit

- ❌ API keys, tokens, secrets
- ❌ `.env` files with real credentials
- ❌ Private keys or certificates
- ❌ Personally identifiable information (PII)
- ❌ Internal URLs or infrastructure details

### ALWAYS Check

- ✅ Run `pnpm check` includes secrets scan
- ✅ Review git diff before commit
- ✅ Use `.gitignore` for sensitive files
- ✅ Redact sensitive info in logs/screenshots

## Documentation Rules

### Every New Feature Must Have

1. **User documentation** - How to use it
2. **Setup documentation** - How to configure it
3. **Troubleshooting guide** - Common issues
4. **Example usage** - Working examples
5. **API documentation** - For public APIs

### Documentation Quality

- ✅ Clear, concise language
- ✅ Working code examples
- ✅ Links to related docs
- ✅ Updated table of contents
- ✅ No broken links
- ✅ Consistent formatting

## Version Control Rules

### Branch Naming

- `fix/<issue-number>-<short-description>` - Bug fixes
- `feat/<issue-number>-<short-description>` - New features
- `docs/<issue-number>-<short-description>` - Documentation
- `refactor/<short-description>` - Refactoring

**Examples**:

- `fix/20518-telegram-polling-diagnostics`
- `feat/aws-bedrock-validation`
- `docs/raspberry-pi-guide`

### Commit Frequency

- **Atomic commits**: Each commit should be a logical unit
- **Meaningful messages**: Explain why, not just what
- **No "WIP" commits**: Squash before PR
- **No merge commits**: Rebase on main before PR

### Force Push Rules

- ❌ NEVER force push to `main`
- ✅ OK to force push to your feature branch (before review)
- ⚠️ Avoid force push after review started (breaks review context)

## Testing Rules

### Required Tests

For bug fixes:

- ✅ Test that reproduces the bug
- ✅ Test that verifies the fix
- ✅ Regression test

For new features:

- ✅ Happy path test
- ✅ Error case tests
- ✅ Edge case tests
- ✅ Integration test (if applicable)

### Test Quality

- Tests must be deterministic (no flaky tests)
- Tests must be fast (unit tests < 1s each)
- Tests must be isolated (no shared state)
- Tests must clean up after themselves

## Emergency Hotfix Protocol

For critical production bugs:

1. Create branch: `hotfix/<issue-number>-<description>`
2. Minimal fix only (no refactoring)
3. Add regression test
4. Fast-track review with maintainer tag
5. Deploy immediately after merge
6. Follow up with comprehensive fix if needed

## Review Process

### After PR is Opened

1. **CI must pass** - Fix any failures immediately
2. **Address feedback** - Respond within 24-48 hours
3. **No scope creep** - Don't add unrelated changes
4. **Be responsive** - Answer questions promptly
5. **Be respectful** - Thank reviewers for their time

### If CI Fails

1. Read the error logs carefully
2. Reproduce locally: `pnpm build && pnpm check && pnpm test`
3. Fix the issue
4. Test locally again
5. Push fix
6. Verify CI passes

## Maintainer Contact

If you need help or clarification:

- **Discord**: #setup-help or #development channels
- **GitHub Discussions**: For feature proposals
- **GitHub Issues**: For bugs or problems
- **Email**: contributing@openclaw.ai (for maintainer applications)

## Current Project Priorities

Focus contributions on:

1. **Security and safe defaults**
2. **Bug fixes and stability**
3. **Setup reliability and first-run UX**
4. **Major model provider support**
5. **Major channel support**
6. **Performance optimization**
7. **Test infrastructure**

## Summary Checklist for Every PR

```markdown
- [ ] All tests pass locally (`pnpm build && pnpm check && pnpm test`)
- [ ] Documentation is formatted (`pnpm check:docs`)
- [ ] Code is formatted (`pnpm format`)
- [ ] Commit messages follow convention
- [ ] PR description includes ALL required sections
- [ ] AI-assisted disclosure included (if applicable)
- [ ] Security impact assessed
- [ ] Human verification documented
- [ ] Evidence attached (logs/screenshots)
- [ ] Failure recovery plan documented
- [ ] No secrets or sensitive data committed
- [ ] Branch name follows convention
- [ ] PR is focused on ONE topic
- [ ] Related issues are linked
- [ ] CI checks are passing
```

---

**This document is the source of truth for all AI agent contributions to OpenClaw.**

**Last Updated**: February 19, 2026
**Version**: 1.0
**Status**: Active and enforced
