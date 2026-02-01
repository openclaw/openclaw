# Pipbot Server Deployment Guide

## Overview

The pipbot server image is stored in Fly.io's container registry and used to provision per-user VMs. This document covers deployment, backup, and disaster recovery.

## Registries

| Registry | Image | Purpose |
|----------|-------|---------|
| Fly.io (primary) | `registry.fly.io/pipbot-prod:<tag>` | Used by VM provisioning |
| GitHub (backup) | `ghcr.io/bloom-street/pipbot:<tag>` | Disaster recovery backup |

## Current Image Tag

The active image tag is configured in `pipbot-server/convex/flyMachines.ts`:
```typescript
image: "registry.fly.io/pipbot-prod:proxy-v1"
```

## Deployment Commands

### Build and Push to Both Registries

```bash
cd pipbot

# Deploy to Fly.io (primary)
fly deploy --image-label <tag> --build-only --push

# Push to GitHub Container Registry (backup)
./scripts/push-backup.sh <tag>
```

### Quick Deploy (Both Registries)

```bash
./scripts/deploy.sh <tag>
```

## Disaster Recovery

### If `pipbot-prod` Fly App is Deleted

1. **Recreate the Fly app:**
   ```bash
   cd pipbot
   fly apps create pipbot-prod
   ```

2. **Rebuild and push the image:**
   ```bash
   fly deploy --image-label <tag> --build-only --push
   ```

3. **Or restore from GitHub backup:**
   ```bash
   # Pull from GitHub
   docker pull ghcr.io/bloom-street/pipbot:<tag>

   # Tag for Fly
   docker tag ghcr.io/bloom-street/pipbot:<tag> registry.fly.io/pipbot-prod:<tag>

   # Push to Fly (requires fly auth docker)
   fly auth docker
   docker push registry.fly.io/pipbot-prod:<tag>
   ```

### If Both Registries Are Lost

Rebuild from source (the git repo is the source of truth):

```bash
cd pipbot
fly apps create pipbot-prod
fly deploy --image-label <tag> --build-only --push
```

Build takes ~2 minutes on Fly's remote builders.

## Updating Existing VMs

New VMs automatically use the configured image tag. To update existing VMs:

1. **Option A: Destroy and re-provision** (clears user data)
   - Use admin panel to destroy VM
   - User's next connection triggers re-provisioning

2. **Option B: Update machine in-place** (preserves data)
   ```bash
   fly machine update <machine-id> --app <user-app-name> \
     --image registry.fly.io/pipbot-prod:<new-tag>
   ```

## Image Tag Convention

| Tag | Description |
|-----|-------------|
| `proxy-v1` | Routes API through Convex proxy for usage tracking |
| `workshop-v1` | Previous version (direct Anthropic API calls) |

When releasing new versions:
1. Choose a descriptive tag name
2. Update `flyMachines.ts` with the new tag
3. Run `npx convex dev --once` to sync
4. Deploy using the commands above

## Environment Variables

The image expects these env vars (set by VM provisioning):

| Variable | Description |
|----------|-------------|
| `CLAWDBOT_GATEWAY_TOKEN` | Auth token for WebSocket connections |
| `PIPBOT_SERVICE_TOKEN` | Service token for Convex proxy auth |
| `CLERK_USER_ID` | User's Clerk ID for usage tracking |
| `CONVEX_URL` | Convex deployment URL |
| `SYNC_SECRET` | Secret for conversation sync |

## Monitoring

Check image availability:
```bash
# Fly registry
fly image list --app pipbot-prod

# GitHub registry
gh api /user/packages/container/pipbot/versions
```
