# OpenClaw Onboard Discord Investigation

## What This Is

An investigation and fix effort for the `openclaw onboard` command when setting up a Discord channel. The onboarding flow completes without obvious errors but leaves the system in a non-functional state — the goal is to run it locally, observe exactly where things go wrong, and fix the root cause.

## Core Value

Running `openclaw onboard` for Discord should leave a fully working setup where messages sent to the bot are processed and answered by Claude.

## Requirements

### Validated

- ✓ `openclaw onboard` command exists and runs — existing
- ✓ Discord channel integration is implemented — existing
- ✓ Gateway run/start infrastructure is in place — existing
- ✓ AI provider configuration (Claude API) is handled — existing

### Active

- [ ] Identify exactly what state `openclaw onboard` leaves behind after Discord setup
- [ ] Determine what "isn't running properly" means — gateway, AI provider, channel config, or daemon
- [ ] Fix the broken behavior so Discord messages route to Claude and responses return
- [ ] Verify end-to-end: send message in Discord → get AI reply

### Out of Scope

- Other channels (Telegram, iMessage, etc.) — focus is Discord only
- UI/UX improvements to onboarding flow — fix behavior first
- New features — investigation and fix only

## Context

This is the openclaw monorepo. The `openclaw onboard` command is the CLI entry point for new user setup. Discord integration lives in `src/discord/`. The onboard command is in `src/commands/`. The codebase map in `.planning/codebase/` has full details on architecture and integrations.

The owner (jbrahy) is running this locally on macOS. Gateway runs as a menubar app or via `openclaw gateway run`.

## Constraints

- **Platform**: macOS — gateway restarts via app, not LaunchAgent
- **Scope**: Discord channel only for this investigation
- **Approach**: Run it live and observe, not speculate

## Key Decisions

| Decision                       | Rationale                            | Outcome   |
| ------------------------------ | ------------------------------------ | --------- |
| Run onboard live before fixing | See actual failure rather than guess | — Pending |

---

_Last updated: 2026-03-17 after initialization_
