# Anonymanetwork Community Priorities (Web Research)

This file tracks what users ask for most around OpenClaw, based on public GitHub issue traffic and recurring support themes.

## Method

- Source: `openclaw/openclaw` public issues
- Signal: high-comment threads + repeated bug reports
- Date: 2026-02-20

## Top priorities

1. Internationalization and localization support
   - Example: issue #3460
   - Why it matters: non-English users want first-class UX in setup, prompts, and docs.

2. Better startup diagnostics and clearer failure output
   - Example: issue #5030 (`no output`)
   - Why it matters: onboarding breaks trust if users cannot quickly identify what failed.

3. More robust global install behavior for Control UI assets
   - Example: issue #4855
   - Why it matters: npm global installs should find assets consistently across environments.

4. Strong plugin ecosystem and provider flexibility
   - Example: issue #8650
   - Why it matters: users want smoother defaults and faster adaptation to provider/plugin changes.

5. Safer provider defaults and account-risk clarity
   - Example: issue #14203
   - Why it matters: users want guardrails to avoid account bans and risky configurations.

## How this fork responds

- Add reproducible research tooling (`scripts/anonymanetwork-feedback-report.mjs`)
- Improve troubleshooting docs in this fork
- Add targeted bugfixes and tests for Control UI path resolution
- Keep changes in small, reviewable commits on feature/bugfix branches
