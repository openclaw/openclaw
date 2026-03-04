# OpenClaw Search Upgrade Phase-3 Notes (2026-03-04)

Issue: https://github.com/HamsteRider-m/hamclaw/issues/2

## Scope Completed

1. Installed `x-reader` with Python 3.14-based pipx venv.
2. Installed Playwright Chromium runtime for `x-reader`.
3. Installed `agent-reach` with pipx and executed `agent-reach install --env=auto --safe`.
4. Installed CLI companions required by planned acceptance checks:
   `modsearch` and `freeride`.

## Commands Executed

```bash
brew install pipx
pipx install --force "x-reader[all] @ git+https://github.com/runesleo/x-reader.git"
~/.local/pipx/venvs/x-reader/bin/python -m playwright install chromium
pipx install --force "https://github.com/Panniantong/agent-reach/archive/main.zip"
agent-reach install --env=auto --safe
npm i -g @liustack/modsearch
pipx install --force ~/.openclaw/skills/free-ride
python3 -m pip install --user --break-system-packages httpx python-dotenv
```

## Verification Snapshot

```text
x-reader: command available (usage printed)
agent-reach doctor: 3/12 channels available baseline (safe mode)
modsearch --help: command available
freeride status: command available, OpenRouter key not set (expected)
deep-research research.py --help: command available
```

## Intentional Non-Goals in This Rollout

1. No cookie import (X/小红书/etc.).
2. No proxy setup.
3. No real API key injection.
4. No channel auth hardening or social-platform login automation.

These remain follow-up tasks after secrets are provided.
