# Monster Bot Runbook

## Goal

Run a high-capability Telegram bot with controlled self-improvement and low regression risk.

## Bootstrap

1. Export runtime vars:
   - `OPENCLAW_CONFIG_PATH=/Users/tazwarmahtab/CascadeProjects/Openclaw-rick/openclaw/configs/openclaw.monster.v2026.3.2.json`
   - `OPENCLAW_WORKSPACE=/Users/tazwarmahtab/CascadeProjects/Openclaw-rick/openclaw`
   - `TELEGRAM_BOT_TOKEN=<rotated-token>`
2. Validate config:
   - `pnpm openclaw config validate`
3. Start gateway:
   - `pnpm openclaw gateway`

## Mandatory token hygiene

- Rotate token if exposed.
- Never commit token to repo.
- Prefer env vars over inline config values.

## Controlled self-update

- Dry-run evolution gates:
  - `scripts/monster/safe-self-evolve.sh dry-run`
- Apply change command through gates:
  - `MONSTER_APPROVAL_NOTE="<approved-by-user-in-chat>" scripts/monster/safe-self-evolve.sh apply "<your-command>"`
- Enable extended tests:
  - `MONSTER_FULL_TESTS=1 MONSTER_APPROVAL_NOTE="<approved-by-user-in-chat>" scripts/monster/safe-self-evolve.sh apply "<your-command>"`

## Persistent memory guarantees (operational)

- Session hooks use fixed default session key (`agent:main:main`) for continuity.
- QMD session exports are persisted under `${OPENCLAW_WORKSPACE}/memory/sessions`.
- `session-memory` hook captures context on `/new` and `/reset` to prevent context loss between threads.

## Quality SLOs

- Gate pass rate: >= 95%
- Regression escape rate: < 2% per release cycle
- Mean recovery time for failed upgrade: < 30 minutes
