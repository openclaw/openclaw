---
name: openclaw-doctor
description: "Autonomous DevOps agent for diagnosing and fixing OpenClaw Gateway issues. Use when: (1) gateway is down or unresponsive, (2) channels not delivering messages, (3) performance degradation or high resource usage, (4) zombie processes (Chrome/Playwright), (5) config issues after upgrade, (6) user asks to check/fix/diagnose gateway health, (7) watchdog mode for continuous monitoring. Runs a REPL loop with 12 tools via OpenAI function calling."
---

# OpenClaw Doctor

Autonomous DevOps agent that diagnoses and fixes OpenClaw Gateway problems using an AI-powered REPL loop.

## Quick start

```bash
# Full auto-diagnosis + fix
python3 {baseDir}/scripts/openclaw-doctor.py

# Check only (read-only, no changes)
python3 {baseDir}/scripts/openclaw-doctor.py --check

# Fix a specific problem
python3 {baseDir}/scripts/openclaw-doctor.py --problem "Telegram не доставляет сообщения"

# Interactive REPL
python3 {baseDir}/scripts/openclaw-doctor.py --interactive

# Watchdog mode (continuous monitoring + auto-fix)
python3 {baseDir}/scripts/openclaw-doctor.py --watch
```

## Modes

| Flag | Mode | Description |
|------|------|-------------|
| _(none)_ | Auto | Full diagnosis + fix. Default mode. |
| `--check` | Check | Read-only diagnosis. No restarts or changes. |
| `--problem "..."` | Problem | Diagnose and fix a specific issue. |
| `--interactive` | REPL | Interactive chat with the doctor agent. |
| `--watch` | Watchdog | Continuous monitoring, auto-fix on failure. |

## How it works

The agent runs a REPL loop powered by GPT with function calling:

```
OBSERVE → THINK → ACT → VERIFY → repeat
  tools    LLM    tools   tools
```

Each iteration the AI decides which tools to call, analyzes results, and takes action. Max 20 iterations per run (configurable).

## Available tools (12)

| Tool | Description | Safe |
|------|-------------|------|
| `check_gateway` | Gateway status + RPC probe | ✅ |
| `get_logs` | Gateway logs with level filter | ✅ |
| `run_doctor` | `openclaw doctor` config check | ✅ |
| `check_resources` | RAM, disk, CPU, top processes | ✅ |
| `check_channels` | Channel probe (Telegram etc.) | ✅ |
| `systemd_journal` | systemd unit journal | ✅ |
| `read_config` | Read openclaw.json | ✅ |
| `fetch_docs` | Fetch docs.openclaw.ai page | ✅ |
| `run_command` | Shell command (dangerous blocked) | ⚠️ |
| `restart_gateway` | systemctl restart + verify | ⚠️ |
| `kill_zombie_processes` | Kill hung processes by pattern | ⚠️ |
| `notify_telegram` | Send Telegram notification | ✅ |

## Safety rules

- Agent diagnoses BEFORE acting (never blind-restart)
- Dangerous shell commands are blocked (`rm -rf`, `mkfs`, etc.)
- Config file (`openclaw.json`) is never modified without user approval
- Max iterations prevent infinite loops
- Watchdog mode has consecutive failure limits

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCTOR_MODEL` | `gpt-5.2` | AI model for diagnosis |
| `DOCTOR_MAX_ITERATIONS` | `20` | Max REPL iterations |
| `DOCTOR_WATCH_INTERVAL` | `30` | Watchdog check interval (seconds) |
| `OPENAI_API_KEY` | _(from env)_ | OpenAI API key |
| `TG_BOT_TOKEN` | _(configured)_ | Telegram bot token for notifications |
| `TG_CHAT_ID` | _(configured)_ | Telegram chat ID for notifications |

## When to use this skill

- User says gateway is down / not responding
- Telegram/channels stopped working
- After `openclaw upgrade` something broke
- High memory / disk usage on VPS
- Zombie Chrome/Playwright processes
- Any "openclaw не работает" complaint
- Periodic health checks

## Integration with watchdog

This skill replaces the simpler `gateway-watchdog.sh` with a smarter AI-driven agent. For basic monitoring, use `--watch` mode. For one-off diagnostics, use `--check` or `--problem`.

## Troubleshooting docs reference

When the agent needs more context, it fetches from:
- `docs.openclaw.ai/gateway/troubleshooting` — full runbook
- `docs.openclaw.ai/gateway/health` — health check steps
- `docs.openclaw.ai/concepts/model-providers` — model/auth issues

## Requirements

- Python 3.10+
- `openai` Python package (`pip install openai`)
- `OPENAI_API_KEY` set in environment
- OpenClaw CLI (`openclaw`) available in PATH
