# OpenClaw Gateway user-systemd snapshot (dvk host)

This folder tracks the gateway user-systemd wiring currently used on `dvkhub`.

Included:

- `openclaw-gateway.service`
- `openclaw-gateway-wait.sh`
- `openclaw-gateway.service.d/30-skills-sync.conf`
- `openclaw-gateway.service.d/20-env.example.conf` (redacted template)

Notes:

- Secrets are intentionally not committed. Use the example file to create local `20-env.conf`.
- Paths are host-specific and intentionally preserved to capture the exact runtime logic.
- After updating files under `~/.config/systemd/user/`, run:

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway.service
systemctl --user status openclaw-gateway.service --no-pager -l
```
