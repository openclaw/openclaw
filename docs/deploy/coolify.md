---
summary: "Deploy OpenClaw Gateway on Coolify with Docker Compose"
read_when:
  - You want to run OpenClaw on Coolify
  - You need a production-ready, containerized deployment
---

# Deploy OpenClaw on Coolify

This guide covers deploying OpenClaw Gateway on [Coolify](https://coolify.io/) using Docker Compose with robust production defaults.

## Overview

- **Non-standard port** (28471) for security through obscurity
- **Auto-generated gateway token** persisted across restarts
- **ZAI provider pre-configured** with explicit endpoint (required)
- **Security hardening**: non-root user, read-only filesystem, no-new-privileges
- **Resource limits**: 6GB memory limit, 2GB reservation (for 8GB RAM / 2 vCPU)

## Prerequisites

- Coolify instance (self-hosted or cloud)
- Server with minimum 4GB RAM (8GB recommended)
- Docker and Docker Compose v2
- ZAI API key from [z.ai](https://z.ai/)

## Deployment Steps

### 1. Create Service Stack

1. In Coolify dashboard, go to **Services** → **New Service Stack**
2. Choose **Docker Compose** as Build Pack
3. Name your service (e.g., `openclaw`)
4. Paste the contents of `docker-compose.coolify.yml`
5. Click **Save**

### 2. Configure Environment Variables

In the Coolify UI, navigate to **Environment Variables** and set:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | No | Auto-generated | Gateway auth token. Leave empty to auto-generate. |
| `ZAI_API_KEY` | **Yes** | Fake placeholder | Your real ZAI API key from [z.ai](https://z.ai/) |
| `OPENCLAW_GATEWAY_PORT` | No | 28471 | Non-standard port for security |
| `OPENCLAW_GATEWAY_BIND` | No | 0.0.0.0 | Bind address (0.0.0.0 for Coolify) |

**Important**: The default `ZAI_API_KEY` is a fake placeholder. You **must** replace it with your real key.

### 3. Assign Domain (Optional but Recommended)

1. In your service, go to **Domains**
2. Add your domain: `https://openclaw.yourdomain.com`
3. Coolify's Traefik will handle SSL and routing
4. The gateway will be accessible via domain instead of IP:port

### 4. Deploy

1. Click **Deploy**
2. Monitor the deployment logs
3. On first run, look for the generated gateway token in logs:
   ```
   [openclaw] Generated new gateway token: <your-token-here>
   ```

### 5. Verify Deployment

Check the health status in Coolify dashboard:
- Should show **Healthy** after ~30 seconds
- If unhealthy, check logs for errors

## Post-Deployment

### Retrieve Gateway Token

If you didn't set `OPENCLAW_GATEWAY_TOKEN` explicitly:

1. Go to **Logs** in Coolify UI
2. Look for line: `[openclaw] Generated new gateway token: ...`
3. Copy this token for client connections

**Note**: The token is persisted to `/home/node/.openclaw/.gateway_token` in the volume. It survives container restarts but not volume deletion.

### Connect Clients

Use the Coolify-assigned domain or server IP:

```bash
# Via domain (if configured)
openclaw dashboard --host https://openclaw.yourdomain.com --token <token>

# Via IP:port
openclaw dashboard --host http://your-server-ip:28471 --token <token>
```

## Configuration Details

### Volume Persistence

| Path | Persistence | Contents |
|------|-------------|----------|
| `/home/node/.openclaw` | Named volume `openclaw-data` | Config, workspace, sessions, token |
| `/tmp` | tmpfs | Temporary files (ephemeral) |

### Security Features

- **Non-root user**: Runs as `node` (uid 1000) from Dockerfile
- **Read-only root filesystem**: Prevents runtime modifications
- **No new privileges**: Prevents privilege escalation
- **Capability drop**: All capabilities removed
- **tmpfs mounts**: Writable only for `/tmp`, `/var/tmp`, `/run`

### Resource Allocation

For 8GB RAM / 2 vCPU servers:

| Resource | Limit | Reservation |
|----------|-------|-------------|
| Memory | 6GB | 2GB |
| CPU | 1.8 cores | 0.5 cores |

Adjust in `docker-compose.coolify.yml` if your server specs differ.

## Troubleshooting

### Container Unhealthy

Check logs for:
- Missing `ZAI_API_KEY` (must be real, not placeholder)
- Port conflicts (ensure 28471 is available)
- Permission errors (volume ownership)

### Token Lost After Recreate

If you deleted the service and recreated:
1. The named volume may have been deleted
2. Set `OPENCLAW_GATEWAY_TOKEN` explicitly in environment variables
3. Or copy the token from logs before deleting

### ZAI Connection Errors

Ensure:
- `ZAI_API_KEY` is set to your real key (not the fake default)
- Key is valid and has credits at [z.ai](https://z.ai/)

## Updates

To update OpenClaw:

1. Update your repository (if using git-based build)
2. Or update image tag in Coolify
3. Click **Redeploy** in Coolify UI
4. Configuration persists in volume

## Architecture

```
┌─────────────────────────────────────┐
│           Coolify Server            │
│  ┌───────────────────────────────┐  │
│  │     Traefik (Reverse Proxy)   │  │
│  │    https://openclaw.domain    │  │
│  └───────────────┬───────────────┘  │
│                  │                  │
│  ┌───────────────▼───────────────┐  │
│  │   OpenClaw Gateway Container  │  │
│  │   - Port 28471                │  │
│  │   - Auto-generated token      │  │
│  │   - ZAI provider configured   │  │
│  └───────────────┬───────────────┘  │
│                  │                  │
│  ┌───────────────▼───────────────┐  │
│  │   Named Volume: openclaw-data │  │
│  │   - Config (openclaw.json)    │  │
│  │   - Workspace                 │  │
│  │   - Sessions                  │  │
│  │   - Token file                │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

## References

- [Coolify Documentation](https://coolify.io/docs/)
- [OpenClaw Docker Guide](/install/docker)
- [ZAI Provider Documentation](/providers/zai)
