# Production Deployment Guide: OpenClaw on Hostinger VPS
## Secure Docker Setup with HTTPS and Multi-Model AI Fallback

**Last Updated:** February 23, 2026  
**Target Platform:** Hostinger VPS with Docker Manager  
**Domain:** openclaw.yahwan.biz  
**Security Level:** Production-hardened

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Phase 1: DNS and SSL Setup](#phase-1-dns-and-ssl-setup)
4. [Phase 2: GitHub Secrets Configuration](#phase-2-github-secrets-configuration)
5. [Phase 3: Docker Hub Setup](#phase-3-docker-hub-setup)
6. [Phase 4: Build and Push Docker Image](#phase-4-build-and-push-docker-image)
7. [Phase 5: Hostinger Deployment (Docker Manager)](#phase-5-hostinger-deployment-docker-manager)
8. [Phase 6: Verification and Testing](#phase-6-verification-and-testing)
9. [Maintenance and Operations](#maintenance-and-operations)
10. [Troubleshooting](#troubleshooting)
11. [Security Hardening Checklist](#security-hardening-checklist)

---

## Overview

This guide walks through deploying OpenClaw on a Hostinger VPS using:
- **Docker** for containerization
- **GitHub Actions** for automated builds
- **Docker Hub** for image registry
- **Let's Encrypt** for HTTPS certificates
- **Multi-model fallback** for AI resilience

**Architecture Flow:**
```
User → openclaw.yahwan.biz (Squarespace DNS)
  ↓
Hostinger VPS Public IP
  ↓
Let's Encrypt SSL (443 → 18789)
  ↓
Docker Container (piboonsak/openclaw:latest)
  ↓
OpenClaw Gateway (Claude Opus → Haiku → Kimi fallback)
```

---

## Prerequisites

### Required Accounts
- ✅ Hostinger VPS (KVM2+ plan with Docker support)
- ✅ Docker Hub account (username: `piboonsak`)
- ✅ GitHub account with repo access
- ✅ Anthropic account with API key
- ✅ Domain registered (openclaw.yahwan.biz via Squarespace)

### Required Credentials (Prepare These)
- `DOCKER_USERNAME`: piboonsak
- `DOCKER_TOKEN`: Docker Hub Personal Access Token
- `OPENCLAW_GATEWAY_TOKEN`: 48-char hex (generate: `openssl rand -hex 24`)
- `ANTHROPIC_API_KEY`: sk-ant-... (from console.anthropic.com)
- `MOONSHOT_API_KEY`: sk-... (optional, from platform.moonshot.cn)

### Local Tools
- Git client
- Docker Desktop (for testing locally, optional)
- SSH client (for VPS access, optional)

---

## Phase 1: DNS and SSL Setup

### Step 1.1: Configure DNS A Record

**On Squarespace DNS Manager:**

1. Log into Squarespace → Domains → openclaw.yahwan.biz
2. Navigate to **DNS Settings**
3. Add/Update **A Record**:
   ```
   Host:  openclaw
   Type:  A
   Value: <your-hostinger-vps-ip>
   TTL:   3600 (1 hour)
   ```
4. Click **Save**
5. Wait 15-30 minutes for DNS propagation

**Verify DNS:**
```bash
# Check DNS resolution
nslookup openclaw.yahwan.biz
# or
ping openclaw.yahwan.biz
```

Expected: Should resolve to your Hostinger VPS IP address.

### Step 1.2: Install SSL Certificate on Hostinger

**In Hostinger hPanel:**

1. Log into hPanel → Select your VPS
2. Navigate to **SSL Certificates**
3. Click **Let's Encrypt** (free)
4. Select domain: `openclaw.yahwan.biz`
5. Click **Install Certificate**
6. Wait ~2 minutes for provisioning

**Verify SSL:**
```bash
# Test HTTPS endpoint (will fail until container deployed)
curl -I https://openclaw.yahwan.biz/
```

Expected: SSL certificate valid, 503/502 (no service yet).

---

## Phase 2: GitHub Secrets Configuration

### Step 2.1: Create Docker Hub Personal Access Token

1. Log into Docker Hub (hub.docker.com)
2. Go to **Account Settings** → **Security**
3. Click **New Access Token**
4. Name: `GitHub Actions - OpenClaw`
5. Permissions: **Read, Write, Delete**
6. Copy token (shows only once!)

### Step 2.2: Add Secrets to GitHub Repository

**In GitHub:**

1. Go to repository: `github.com/openclaw/openclaw`
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add each secret:

   **Secret 1:**
   ```
   Name:  DOCKER_USERNAME
   Value: piboonsak
   ```

   **Secret 2:**
   ```
   Name:  DOCKER_TOKEN
   Value: <paste-your-docker-hub-token>
   ```

5. Click **Add secret** for each

**Verify:**
- Secrets list should show: `DOCKER_USERNAME`, `DOCKER_TOKEN`
- Values are masked (••••••)

---

## Phase 3: Docker Hub Setup

### Step 3.1: Create Repository

1. Log into Docker Hub
2. Click **Create Repository**
3. Fill form:
   ```
   Name:        openclaw
   Description: Multi-channel AI gateway with extensible messaging integrations
   Visibility:  Public (or Private if preferred)
   ```
4. Click **Create**

Your repo URL: `hub.docker.com/r/piboonsak/openclaw`

---

## Phase 4: Build and Push Docker Image

### Step 4.1: Trigger GitHub Actions Build

**Automatic (recommended):**

1. Go to GitHub Actions tab in your repo
2. Select workflow: **Build and Push Docker Image**
3. Latest push to `main` should trigger automatically

**Manual trigger:**

1. GitHub → Actions → **Build and Push Docker Image**
2. Click **Run workflow**
3. Select branch: `main`
4. Click **Run workflow**

### Step 4.2: Monitor Build Progress

1. Click on the running workflow
2. Watch build steps:
   - ✅ Checkout code
   - ✅ Set up Docker Buildx
   - ✅ Log in to Docker Hub
   - ✅ Extract metadata
   - ✅ Build and push Docker image
   - ✅ Image digest

Expected: All steps green, ~5-10 minutes total.

### Step 4.3: Verify Image on Docker Hub

1. Go to Docker Hub → piboonsak/openclaw
2. Check **Tags** tab
3. Should see:
   - `latest` (from main branch)
   - `main-<sha>` (commit SHA)
   - Optional: version tags if you tagged a release

**Test pull locally (optional):**
```bash
docker pull piboonsak/openclaw:latest
docker inspect piboonsak/openclaw:latest
```

---

## Phase 5: Hostinger Deployment (Docker Manager)

### Step 5.1: Access Docker Manager

1. Log into Hostinger hPanel
2. Select your VPS
3. Click **Docker Manager** (in sidebar)

### Step 5.2: Create New Service

1. Click **New Service** or **Custom Template**
2. Fill form:

   **Basic Info:**
   ```
   Service Name: openclaw-gateway
   Image:        piboonsak/openclaw:latest
   ```

   **Port Mapping:**
   ```
   External: 18789
   Internal: 18789
   Protocol: TCP
   ```

### Step 5.3: Environment Variables

Click **Environment Variables** → **Add Variable** for each:

```bash
# REQUIRED
OPENCLAW_GATEWAY_TOKEN=<your-48-char-hex-token>

# AI Providers (at least one)
ANTHROPIC_API_KEY=sk-ant-<your-key>
MOONSHOT_API_KEY=sk-<your-key>  # Optional

# System
NODE_ENV=production
OPENCLAW_LOAD_SHELL_ENV=0
```

**⚠️ CRITICAL:** Ensure tokens are kept secret. Hostinger encrypts env vars at rest.

### Step 5.4: Volume Mounts

Click **Volumes** → **Add Volume**:

**Volume 1: State Directory**
```
Host Path:      /data/openclaw/state
Container Path: /data/openclaw/state
Mode:           Read/Write
```

**Volume 2: Workspace Directory**
```
Host Path:      /data/openclaw/workspace
Container Path: /data/openclaw/workspace
Mode:           Read/Write
```

### Step 5.5: Advanced Settings

If available, configure:

```
Memory Limit:    2GB
CPU Limit:       2 cores
Restart Policy:  always
Health Check:    Enabled
  - Endpoint:    http://localhost:18789/health
  - Interval:    30s
  - Timeout:     10s
  - Retries:     3
```

### Step 5.6: Deploy

1. Review all settings
2. Click **Deploy** or **Create Service**
3. Wait ~1-2 minutes for initial pull and startup

---

## Phase 6: Verification and Testing

### Step 6.1: Check Service Status

**In Docker Manager:**
1. Service status should show: **Running** (green)
2. Click service → **Logs** tab
3. Look for startup messages:
   ```
   Gateway started on port 18789
   Model providers initialized: anthropic
   Health endpoint available at /health
   ```

### Step 6.2: Test Health Endpoint

```bash
# Test from external
curl https://openclaw.yahwan.biz/health

# Expected response:
{
  "status": "ok",
  "version": "2026.2.22",
  "uptime": 123
}
```

### Step 6.3: Access Web UI

1. Open browser: `https://openclaw.yahwan.biz/`
2. Should see OpenClaw login screen
3. Enter `OPENCLAW_GATEWAY_TOKEN`
4. Click **Login**
5. Chat interface should load

### Step 6.4: Test AI Chat

1. In chat interface, send: `Hello, what model are you using?`
2. Expected response from Claude Opus
3. Check response quality and latency

### Step 6.5: Verify Model Fallback (Optional)

1. Go to **Config** tab
2. Check `agents.defaults.model.fallback` list:
   - anthropic/claude-3-5-haiku
   - moonshot/kimi-k2.5
3. Try manually switching models in chat settings

---

## Maintenance and Operations

### Updating the Image

**When code changes are pushed to main:**

1. GitHub Actions automatically builds new image
2. In Hostinger Docker Manager:
   - Click service → **Actions** → **Recreate**
   - Or: **Stop** → **Start** (pulls latest)
3. Monitor logs for successful restart

**Manual pull:**
```bash
# If you have SSH access
ssh user@vps-ip
docker pull piboonsak/openclaw:latest
docker-compose -f /path/to/docker-compose.prod.yml up -d --force-recreate
```

### Rotating Secrets

**Gateway Token:**
1. Generate new token: `openssl rand -hex 24`
2. Update in Hostinger Docker Manager → Environment Variables
3. Restart service
4. Update token in your password manager

**API Keys:**
1. Generate new key in provider console
2. Update in Hostinger Docker Manager → Environment Variables
3. Restart service (zero downtime with fallback models)

### Viewing Logs

**Hostinger Docker Manager:**
- Click service → **Logs** tab
- Real-time tail or download full log

**SSH access:**
```bash
docker logs openclaw-gateway -f --tail 100
```

### Backup Strategy

**What to backup:**
- `/data/openclaw/state` (config, credentials, sessions)
- `/data/openclaw/workspace` (agent working files)
- Environment variables (from Hostinger UI → export)

**How:**
- Hostinger Daily Backups (enabled during VPS purchase)
- Manual: `docker run --rm -v openclaw-state:/data -v /backup:/backup busybox tar czf /backup/openclaw-state-$(date +%F).tar.gz /data`

---

## Troubleshooting

### Issue: Service won't start

**Symptoms:**
- Docker Manager shows "Exited" or "Error"
- Logs show startup errors

**Resolution:**
1. Check logs for specific error
2. Common causes:
   - Missing `OPENCLAW_GATEWAY_TOKEN`
   - Missing AI provider API key
   - Invalid port mapping
   - Insufficient memory/CPU
3. Fix env vars or resource limits
4. Restart service

### Issue: Can't access https://openclaw.yahwan.biz/

**Check DNS:**
```bash
nslookup openclaw.yahwan.biz
# Should resolve to VPS IP
```

**Check SSL:**
```bash
curl -I https://openclaw.yahwan.biz/
# Should return 200 or valid SSL
```

**Check Docker port:**
```bash
# On VPS via SSH
ss -ltnp | grep 18789
# Should show process listening
```

**Check firewall:**
- Hostinger usually opens ports automatically
- Verify in hPanel → Firewall

### Issue: SSL certificate error

**Resolution:**
1. hPanel → SSL Certificates
2. Verify cert installed for `openclaw.yahwan.biz`
3. Check expiration date (Let's Encrypt = 90 days, auto-renews)
4. If expired: **Renew** button
5. Wait 5 minutes, clear browser cache

### Issue: Model returns errors

**Symptoms:**
- "API key invalid"
- "Rate limit exceeded"
- "Model not found"

**Resolution:**
1. Verify API key is correct in Hostinger env vars
2. Check provider console for quota/balance
3. Test API key with curl:
   ```bash
   curl https://api.anthropic.com/v1/messages \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'
   ```
4. Check if fallback model is configured and working

### Issue: High memory/CPU usage

**Check resource usage:**
```bash
docker stats openclaw-gateway
```

**Resolution:**
1. Increase limits in Hostinger Docker Manager
2. Or upgrade VPS plan
3. Check for memory leaks in logs
4. Restart service to clear temporary state

---

## Security Hardening Checklist

### Container Security
- [x] Non-root user (uid 1000)
- [x] Read-only filesystem (except volumes)
- [x] No new privileges flag
- [x] All capabilities dropped
- [x] Resource limits enforced
- [x] Health checks enabled

### Network Security
- [x] HTTPS only (Let's Encrypt)
- [x] Gateway auth required (token)
- [x] Internal bridge network
- [ ] Optional: Disable external network for sandbox

### Application Security
- [x] DM policy: pairing (not open)
- [x] Dangerous node commands denied
- [x] Sandbox enabled with blocklist
- [x] Secrets in env vars (not in config)
- [x] Sensitive values redacted in logs

### Operational Security
- [x] Daily backups enabled
- [x] Credentials in password manager
- [x] API keys rotated regularly
- [x] Logs monitored for anomalies
- [ ] Alerting configured (optional)

### Configuration Review
- [ ] Run `openclaw doctor` (if supported via CLI)
- [ ] Review security audit findings
- [ ] No critical warnings present
- [ ] All env vars validated

---

## Appendix: Alternative Deployment (docker-compose)

If you have SSH access to your VPS and prefer docker-compose:

### Setup .env file:
```bash
cd /opt/openclaw
cp .env.example .env
nano .env  # Fill in your secrets
```

### Deploy:
```bash
docker-compose -f docker/docker-compose.prod.yml up -d
```

### View logs:
```bash
docker-compose -f docker/docker-compose.prod.yml logs -f
```

### Update:
```bash
docker-compose -f docker/docker-compose.prod.yml pull
docker-compose -f docker/docker-compose.prod.yml up -d --force-recreate
```

---

## Support and Resources

- **OpenClaw Docs:** https://docs.openclaw.ai/
- **GitHub Issues:** https://github.com/openclaw/openclaw/issues
- **Docker Hub:** https://hub.docker.com/r/piboonsak/openclaw
- **Hostinger Support:** https://support.hostinger.com/

**Deployment Plan:** [plan-hostingerSecureDeployment.prompt.md](../../Openclaw/docs/plan-hostingerSecureDeployment.prompt.md)

---

**Version:** 1.0  
**Status:** Production Ready  
**Last Verified:** February 23, 2026
