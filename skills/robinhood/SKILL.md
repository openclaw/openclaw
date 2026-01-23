---
name: robinhood
description: Check Robinhood portfolio, positions, and account info via robin_stocks Python library.
homepage: https://github.com/jmfernandes/robin_stocks
metadata: {"clawdbot":{"emoji":"🪶","requires":{"bins":["uv"],"env":["ROBINHOOD_USERNAME","ROBINHOOD_PASSWORD"]},"primaryEnv":"ROBINHOOD_USERNAME"}}
---

# Robinhood

Query your Robinhood account using the robin_stocks Python library.

## Setup

Credentials are stored in 1Password under "Robinhood". The skill will fetch them via `op`.

## Commands

### Check Positions
```bash
uv run {baseDir}/scripts/robinhood.py positions
```

### Get Portfolio Summary
```bash
uv run {baseDir}/scripts/robinhood.py portfolio
```

### Check Specific Stock
```bash
uv run {baseDir}/scripts/robinhood.py quote AAPL
```

### Get Account Info
```bash
uv run {baseDir}/scripts/robinhood.py account
```

## Notes

- Robinhood requires 2FA. The script caches the session token after first login.
- For automated use, set up a TOTP secret in 1Password.
- Never log credentials or tokens to chat.
