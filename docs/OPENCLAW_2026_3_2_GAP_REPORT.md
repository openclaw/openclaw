# OpenClaw v2026.3.2 Gap Report

Date: 2026-03-04

## Source of truth

- Release: https://github.com/openclaw/openclaw/releases/tag/v2026.3.2
- Changelog in repo: `CHANGELOG.md`

## Executive result

- **Core code gap to v2026.3.2: none detected.**
- Your workspace packages already report `2026.3.2`.
- Remaining gap is **configuration + operating model**, not missing code.

## Feature parity matrix (requested highlights)

1. Telegram live streaming

- Release status: shipped in v2026.3.2.
- Repo status: present (`channels.telegram.streaming`).
- Your gap: needed explicit enablement.
- Action: enabled in `configs/openclaw.monster.v2026.3.2.json`.

2. ACP subagents on by default

- Release status: ACP dispatch/runtime matured and default paths improved.
- Repo status: present (`acp.*`, `extensions/acpx`).
- Your gap: needed explicit policy/runtime config.
- Action: `acp.enabled=true`, `acp.dispatch.enabled=true`, `acp.backend=acpx`, stream/runtime tuned.

3. Native PDF tool

- Release status: shipped with model routing + limits.
- Repo status: present (`pdf` tool + `agents.defaults.pdfModel`).
- Your gap: model/limits were not fully tuned.
- Action: configured `pdfModel`, `pdfMaxBytesMb`, `pdfMaxPages`, and tool allowlist.

4. Config validate

- Release status: shipped (`openclaw config validate`).
- Repo status: present and runnable.
- Your gap: no dedicated hardened preset to validate.
- Action: added `configs/openclaw.monster.v2026.3.2.json` and validated it.

5. Security and stability hardening wave

- Release status: extensive changes in 2026.3.2.
- Repo status: code present.
- Your gap: enforce stronger runtime policy.
- Action: gateway HTTP tool denylist, plugin allowlist, loop detection, scoped subagent permissions.

## Additional capability wiring completed

- QMD memory backend + session indexing + hybrid retrieval config.
- Single-role agent team architecture (`main`, `researcher`, `builder`, `critic`).
- Modular personality files injected at bootstrap with `bootstrap-extra-files` hook.
- Session-memory + command logger hooks enabled for reinforcement-ready traces.

## Remaining external prerequisites (not code gaps)

- Install and verify `qmd` executable for `memory.backend=qmd`.
- Install and verify ACP backend binary/plugin path (`acpx`).
- Set runtime secrets (`TELEGRAM_BOT_TOKEN`, model provider keys, `OPENCLAW_WORKSPACE`).
