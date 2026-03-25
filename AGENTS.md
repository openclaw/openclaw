# OpenClaw Agent Guide

> CONSUMER PRODUCT: Read `CONSUMER.md` before starting work here.
>
> This file is intentionally lean. If a section starts turning into a playbook, move it into a focused doc and leave a pointer here.

## Default repo stance

- Treat this checkout as the consumer-product fork unless the user says otherwise.
- Do not assume upstream `openclaw/openclaw` workflow by default.
- Do not recreate or target a `consumer` branch for new work. Use `codex/consumer-openclaw-project`.
- If the user says "consumer branch", interpret that as `codex/consumer-openclaw-project` unless they explicitly say they mean the legacy `consumer` branch.
- Never merge `upstream/main` into fork branches. Upstream intake is selective only.
- PR targets:
  - Consumer-product work: `codex/consumer-openclaw-project`
  - General fork work: this repo's `main`
  - Upstream work: `https://github.com/openclaw/openclaw` only when the user explicitly asks for upstream PR or review flow
- `consumer` is a legacy branch. Do not target new PRs there unless the user explicitly asks.

## Always-on rules

- In chat replies, use repo-root-relative file references only.
- Read `SECURITY.md` before any security triage, advisory work, or severity decision.
- Before touching gateway runtime ownership, worktree bot validation, or LaunchAgent behavior, read `docs/agent-guides/workflow.md` and `docs/agent-guides/runtime-ops.md`.
- Before opening or updating a PR:
  - For fork PRs targeting `artemgetmann/openclaw` `main` or `codex/consumer-openclaw-project`, read `FORK_CONTRIBUTING.md`
  - For upstream PRs or other targets, read `CONTRIBUTING.md`
- Read `.github/pull_request_template.md` before opening or updating a PR.
- Do not edit security-owned paths unless a listed owner asked for the change or is already reviewing it.
- Do not edit generated `docs/zh-CN/**` unless the user explicitly asks.
- Never edit `node_modules`.
- Never update the Carbon dependency.
- Do not patch dependencies without explicit approval.
- When adding a new `AGENTS.md`, add a sibling `CLAUDE.md` symlink to it.

## Load only the docs you need

- Product context and current priorities:
  - `CONSUMER.md`
  - `docs/consumer/openclaw-consumer-execution-spec.md`
- Branching, PR targets, commits, GitHub footguns:
  - `docs/agent-guides/workflow.md`
- Fork maintenance and upstream intake:
  - `docs/agent-guides/fork-maintenance.md`
- Build, test, style, and validation:
  - `docs/agent-guides/dev-and-test.md`
- Docs authoring, Mintlify rules, and i18n:
  - `docs/agent-guides/docs-and-content.md`
- Telegram live checks and worktree bot setup:
  - `docs/agent-guides/telegram-live.md`
- Runtime ops, logs, timeout triage, and mac app behavior:
  - `docs/agent-guides/runtime-ops.md`
- Parallels smoke runs:
  - `docs/agent-guides/parallels-smoke.md`
- Releases, versions, and security advisories:
  - `docs/agent-guides/release-and-security.md`

## Deep references

- `docs/testing.md`
- `docs/debug/worktree-branch-survival.md`
- `scripts/telegram-e2e/README.md`
- `.agents/skills/PR_WORKFLOW.md`
