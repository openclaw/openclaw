# Stable Chrome CDP Setup (Linux + systemd)

This guide covers Linux with systemd. For macOS/Windows, see platform-specific examples.

## Why this setup

Common failure modes on Linux:

- CDP endpoint unstable or unreachable
- display/X authority issues
- extension relay mismatch when direct CDP is intended
- dynamic page refs changing between snapshot and click/type

## 1) Create dedicated automation profile

Use a dedicated Chrome user-data-dir instead of your daily profile directly.

Example destination:

- `$HOME/chrome-profiles/main-openclaw`

You can sync from default profile with `sync-main-profile-to-openclaw.sh`.

## 2) Start Xvfb and Chrome CDP with user services

Use templates:

- `examples/systemd/openclaw-xvfb.service`
- `examples/systemd/openclaw-chrome-main.service`

Install (example):

```bash
mkdir -p ~/.config/systemd/user
cp examples/systemd/openclaw-xvfb.service ~/.config/systemd/user/
cp examples/systemd/openclaw-chrome-main.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openclaw-xvfb.service
systemctl --user enable --now openclaw-chrome-main.service
```

## 3) Point OpenClaw browser profile to CDP

Set OpenClaw browser profile CDP URL to loopback endpoint (example `127.0.0.1:18804`) and make it default if needed.

## 4) Validate

```bash
openclaw browser status --json
openclaw browser open https://x.com/compose/post --json
openclaw browser snapshot --json --efficient --limit 200
```

## 5) Dynamic pages: stale-ref-safe actions

Do not reuse old refs on dynamic pages.

Recommended loop:

1. snapshot
2. resolve ref by semantic attributes (role/name)
3. action (type/click)
4. if error: wait + fresh snapshot + retry

Production hints from current CDP usage:

- **Lock by targetId** once you open/reuse a tab, and pass `--target-id` on every command.
- Take a **fresh snapshot before each action** (`type`, `click`, upload steps), especially on React/Vue pages.
- Treat failed actions as potentially stale refs and run a **stale-ref retry loop** (small wait + fresh snapshot + ref re-resolve).
- Prefer semantic matching (`role` + name regex) over positional assumptions.

Example helper:

- `examples/scripts/openclaw-browser-safe-action.sh` (generic action engine)
- `examples/scripts/openclaw-x-post.sh` (X-specific wrapper on top)

## Troubleshooting

- If service starts but CDP is down, verify port binding and process args.
- If snapshot works but click fails, refresh refs before each action.
- If you use strict network policies, ensure local loopback CDP is still reachable.
