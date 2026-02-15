# Running OpenClaw in Docker on macOS

This guide covers running OpenClaw in Docker on macOS, which requires special handling due to permission differences between macOS and Linux containers.

## The Problem

When running Docker on macOS:
- macOS users have uid 501 (typically)
- Docker containers run with uid 1000 (node user)
- Volume-mounted files keep host permissions
- Config paths like `/Users/username/...` don't exist in the container
- Result: Permission errors, "invalid credentials", path resolution failures

## Quick Solution

Use the macOS-specific Dockerfile and compose file:

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Build with macOS Dockerfile
docker build -f Dockerfile.macos -t openclaw:macos .

# Start with macOS compose
docker compose -f docker-compose.macos.yml up -d
```

## Prerequisites

Before starting, ensure your `~/.openclaw/openclaw.json` has:

```json
{
  "gateway": {
    "bind": "lan"
  }
}
```

> **Important:** The default `"bind": "loopback"` won't work in Docker - the web UI will be unreachable from outside the container.

## What the macOS Setup Does

1. **Symlink for path compatibility**: Creates `/Users/<username>` → `/home/node` so macOS paths in your config resolve correctly
2. **Smart permission fixes**: Only chowns essential directories (skips `.git` to avoid hanging)
3. **Security hardening**: 
   - `no-new-privileges` - prevents privilege escalation
   - `cap_drop: ALL` - drops all Linux capabilities
   - Minimal `cap_add` for only what's needed
4. **gosu for user switching**: Properly switches from root to node user after fixing permissions

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_HOST_USER` | `$USER` | Your macOS username (for symlink) |
| `OPENCLAW_GATEWAY_TOKEN` | (required) | Gateway auth token |
| `OPENCLAW_GATEWAY_BIND` | `lan` | Network binding mode |

### Security Recommendations

1. **Command Allowlist**: Create `~/.openclaw/exec-approvals.json`:
   ```json
   {
     "version": 1,
     "defaults": {
       "security": "allowlist",
       "ask": "on-miss"
     },
     "agents": {
       "main": {
         "allowlist": [
           { "pattern": "git *" },
           { "pattern": "npm *" },
           { "pattern": "node *" }
         ]
       }
     }
   }
   ```

2. **Lock credentials**:
   ```bash
   chmod 600 ~/.openclaw/credentials/*.json
   ```

## Troubleshooting

### "pairing required" error
Approve your device:
```bash
openclaw devices list
openclaw devices approve <request-id>
```

### Can't access web UI
1. Verify `bind: "lan"` in config (not `loopback`)
2. Restart container after config changes
3. Check logs: `docker logs openclaw`

### Permission errors on startup
The entrypoint skips `.git` directories. If issues persist:
```bash
# On host
chmod -R a+r ~/.openclaw/workspace
```

### Path errors mentioning `/Users`
Ensure `OPENCLAW_HOST_USER` is set correctly in your environment or compose file.

## Accessing the Dashboard

- **URL**: http://localhost:18789
- **Token**: Found in `~/.openclaw/openclaw.json` under `gateway.auth.token`

## Browser Access from Docker

If you need browser automation from inside Docker, the host browser can be reached at `host.docker.internal:9222`, but requires a Host header workaround.

**Run this on your Mac (not inside the container):**
```bash
curl -H "Host: localhost:9222" http://host.docker.internal:9222/json/version
```

Note: The container itself uses this address internally for browser automation when configured.

## Files Reference

- `Dockerfile.macos` - macOS-compatible Dockerfile
- `docker-compose.macos.yml` - macOS-specific compose file
- `~/.openclaw/exec-approvals.json` - Command allowlist
