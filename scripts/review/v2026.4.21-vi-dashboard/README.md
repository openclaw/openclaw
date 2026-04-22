# Review lane: `v2026.4.21-vi-dashboard`

This lane boots the `review/v2026.4.21-vi-dashboard` worktree as an isolated
dashboard-review gateway.

## What is isolated

- Worktree branch: `review/v2026.4.21-vi-dashboard`
- Base port: `19821`
- State dir: `~/.openclaw-review-v2026-4-21-vi-dashboard`
- Config path: `~/.openclaw-review-v2026-4-21-vi-dashboard/openclaw.json`
- Workspace: `~/.openclaw-review-v2026-4-21-vi-dashboard/workspace`
- Gateway token: `~/.openclaw-review-v2026-4-21-vi-dashboard/review-gateway.token`
- Transient unit: `openclaw-gateway-review-v2026-4-21.service`

## Safety defaults

- Runs on `127.0.0.1` only
- `gateway.tailscale.mode = "off"`
- `cron.enabled = false`
- `OPENCLAW_SKIP_CHANNELS=1`
- Channel configs are mirrored but forced to `enabled=false`

## Commands

```bash
bash scripts/review/v2026.4.21-vi-dashboard/start.sh
bash scripts/review/v2026.4.21-vi-dashboard/status.sh
bash scripts/review/v2026.4.21-vi-dashboard/info.sh
bash scripts/review/v2026.4.21-vi-dashboard/stop.sh
```

`start.sh` re-syncs the review config from `~/.openclaw/openclaw.json` before
booting, so dashboard-facing config changes from the main lane can be mirrored
without touching the running production runtime.
