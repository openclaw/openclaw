# HEARTBEAT.md - Periodic Maintenance Tasks

## Purpose
Tasks to check periodically to keep MAIBOT healthy. These run on a heartbeat schedule, not every session.

**Note**: Keep file empty (or comments only) to skip heartbeat API calls. Tasks below are guides for manual maintenance checks.

---

## Weekly Tasks

### Monday: Test Coverage Check
- Run `pnpm test:coverage` to verify ≥70% coverage threshold
- Alert if coverage drops below 65%
- Identify files needing additional tests

### Wednesday: Dependency Health
- Check security advisories: `pnpm audit`
- Review outdated packages: `pnpm outdated`
- Note critical updates needed (security-related priority)

### Friday: Documentation Sync
- Verify docs/ changes align with recent code changes
- Check for broken links in Mintlify documentation
- Update CHANGELOG.md if significant changes occurred

---

## Daily Tasks (Active Development Only)

### Morning: Workspace Health
- Check `git status` for uncommitted work
- Remove stale temporary files (`/tmp/moltbot-*.log`)
- Verify no debug artifacts in workspace

### Evening: Session Summary
- Update TOOLS.md if environment-specific knowledge gained
- Update USER.md if learned new 지니 preferences
- Update IDENTITY.md if behavioral patterns evolved

---

## Monthly Tasks

### First Monday: Deep Health Check
- Full test suite: `pnpm test:all`
- Review `.secrets.baseline` for new secrets
- Check for unused dependencies
- Identify files exceeding 700 LOC guideline

### Mid-Month: Skills & Extensions Audit
- Review skills/ folder for outdated patterns
- Check extension channels for updates (bluebubbles, google-auth, etc.)
- Update AGENTS.md if agent patterns changed

---

## Conditional Tasks

### On Error Patterns
- **Repeated Errors** (3+ occurrences): Investigate root cause
- **Test Flakiness**: Stabilize or document as known flake
- **Build Time Increase** (>20%): Profile and optimize

### On New Channel Integration
- Update docs/channels/ with setup guide
- Add channel to .github/labeler.yml
- Document channel-specific patterns in AGENTS.md

### On AI Monetization Experiments
- Document learnings in dedicated monetization/ directory
- Track revenue/cost metrics for experiments
- Update strategy based on results

---

## Implementation Note

These tasks are **guides, not mandates**. Use judgment. If a task doesn't apply in context, skip it. Goal is health maintenance, not bureaucracy.

**EXFOLIATE!** — If a task accumulates cruft without value, remove it from this file.

---

*Last reviewed: 2026-01-30*
