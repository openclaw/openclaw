# CI/CD Workflow - OpenClaw Production Deployment

## ⚠️ CRITICAL RULE

**NEVER SSH directly into VPS to fix issues.** All changes MUST go through this CI/CD pipeline to ensure:
- Changes are version-controlled
- Deployments are reproducible
- VPS crashes can be recovered
- Team members can review/audit changes

---

## Standard Deployment Workflow

### 1. Fix Code Locally

```bash
cd d:\01_gitrepo\openclaw_github

# Make your changes to:
# - config/openclaw.prod.json5
# - docker/docker-compose.prod.yml
# - docker/nginx/openclaw.conf
# - src/** (if code changes needed)
# - .env.example (document new env vars)
# - docker/vps-setup.sh (update env template if needed)
```

**Pre-commit checks:**
```bash
pnpm check           # Lint & format
pnpm test            # Run tests
pnpm build          # Type-check & build
git status          # Verify changed files
```

### 2. Push to Repository

```bash
# Stage only relevant files (avoid temp files)
git add config/openclaw.prod.json5 docker/docker-compose.prod.yml ...

# Commit with descriptive message (follow Conventional Commits)
git commit -m "fix(model): increase maxTokens to 16384 for long responses"

# Push to main
git push origin main
```

**Branch naming conventions:**
- `fix/<issue>-<short-desc>` - Bug fix work (e.g., `fix/ws22-web-search-key`)
- `feat/<short-desc>` - New features (e.g., `feat/line-webhook-retry`)
- `infra/<short-desc>` - Infrastructure-only changes (e.g., `infra/nginx-timeouts`)
- `docs/<short-desc>` - Documentation-only changes (e.g., `docs/cicd-naming`)

**Tag alignment rule (Git tag == Image tag):**
- Use one shared tag for BOTH Git and Docker image.
- Format: `vYYYY.M.D` for release, or `vYYYY.M.D-<fix>` for hotfixes.
- Example: `v2026.2.27` (release), `v2026.2.27-ws22` (hotfix)

**Commit message format:**
- `fix(scope): description` - Bug fixes
- `feat(scope): description` - New features
- `infra(scope): description` - Infrastructure changes
- `docs(scope): description` - Documentation only

### 3. Build Docker Image

**For Linux/CI-CD (build locally or in GitHub Actions):**

```bash
# Build with aligned tag (Git tag == image tag)
docker build -t piboonsak/openclaw:latest -f Dockerfile .
docker build -t piboonsak/openclaw:v2026.2.27-ws22 -f Dockerfile .

# Test locally (optional but recommended)
docker run --rm -it \
  -e OPENROUTER_API_KEY="your-key" \
  -e BRAVE_API_KEY="your-key" \
  piboonsak/openclaw:v2026.2.27-ws22 \
  openclaw --version
```

**For Windows/Mac without Docker:

Skip this step. Your code changes are on GitHub. Production build either:
- Runs automatically in GitHub Actions CI/CD pipeline (future setup)
- Or manually on a Linux machine by DevOps

The VPS will pull the latest published image from Docker Hub:
```bash
docker pull piboonsak/openclaw:latest
```

**Tag naming conventions:**
- `latest` - Current production release
- `vYYYY.M.D` - Release tag (Git tag + image tag)
- `vYYYY.M.D-<fix>` - Hotfix tag (Git tag + image tag)

### 4. Push Image to Docker Hub

**For Linux/CI-CD only:**

```bash
# Login to Docker Hub (if not already logged in)
docker login -u piboonsak

# Push both tags
docker push piboonsak/openclaw:v2026.2.27-ws22
docker push piboonsak/openclaw:latest
```

**Verify on Docker Hub:**
- Visit: https://hub.docker.com/r/piboonsak/openclaw/tags
- Confirm both tags are present
- Check image size matches local build

**For non-Linux developers:**
- This step runs in GitHub Actions (future) or manually by DevOps
- Your job is done after pushing code to GitHub (Step 2)

### 5. Deploy to VPS via SSH

**Manual deployment to production:**

```bash
# SSH into VPS
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@76.13.210.250

# Navigate to deployment directory (CORRECT PATH)
cd /docker/openclaw-sgnl

# Verify environment variables in Hostinger UI are set:
# - OPENROUTER_API_KEY
# - BRAVE_API_KEY (for web search)
# - BRAVE_API_SEARCH_KEY
# - BRAVE_API_ANSWER_KEY
# - LINE_CHANNEL_SECRET
# - LINE_CHANNEL_ACCESS_TOKEN

# Pull new image from Docker Hub
docker pull piboonsak/openclaw:latest

# Restart containers with new image (use docker compose v2 syntax)
docker compose down
docker compose up -d

# Exit SSH
exit
```

**Note:** The VPS deployment directory is NOT a git clone. Code changes (from Step 2) don't automatically sync. Configuration is managed through:
- Hostinger UI (environment variables)
- Docker image tags in `docker-compose.yml`

### 5a. Create Release Git Tag

**After Step 5 deployment succeeds and regression tests pass:**

```bash
# Create Git tag matching image tag (aligned versioning)
git tag v2026.2.27-ws22

# Push tag to GitHub
git push origin v2026.2.27-ws22
```

**Verify on GitHub:**
- https://github.com/Piboonsak/openclaw_github/releases
- New tag should appear with commit details
- Use semantic versioning: `vYYYY.M.D-<fix>` (e.g., `v2026.2.27-ws22`)

**Future: Automated deployment (recommended)**

```bash
# Setup GitHub Actions workflow (TODO)
# .github/workflows/deploy-production.yml
#
# Workflow should:
# 1. Build image on push to main
# 2. Run tests
# 3. Push to Docker Hub
# 4. Trigger deployment webhook on VPS
# 5. Run health checks
# 6. Rollback on failure
```

### 6. Verify OpenClaw Health

**A. Container health check:**

```bash
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@76.13.210.250 \
  "docker ps --filter name=openclaw-sgnl-openclaw-1 --format '{{.Status}}'"

# Expected: "Up X+ minutes (healthy)"
```

**B. Gateway probe:**

```bash
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@76.13.210.250 \
  "docker exec openclaw-sgnl-openclaw-1 openclaw channels status --probe"

# Expected output includes:
# - "Gateway reachable"
# - "LINE default: enabled, configured, running, mode:webhook, token:config, works"
```

**Known Issue - Ignore LINE warnings:**
You may see warnings like:
```
- line default: LINE channel access token not configured
- line default: LINE channel secret not configured
```
Ignore these if:
- "Gateway reachable" is present
- channels show "works" status
- `openclaw config get channels.line` returns the full token/secret values (they exist)

**C. Config verification:**

```bash
# Verify critical config values
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@76.13.210.250 \
  "docker exec openclaw-sgnl-openclaw-1 sh -c 'cat /data/.openclaw/openclaw.json'" | jq '
    {
      maxTokens: .models.providers.openrouter.models[0].maxTokens,
      fallbacks: .agents.defaults.model.fallbacks,
      searchProvider: .tools.web.search.provider
    }
  '
```

**D. Log inspection:**

```bash
# Check for errors in last 50 lines
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@76.13.210.250 \
  "docker logs --tail 50 openclaw-sgnl-openclaw-1 2>&1 | grep -i error"

# Should return empty or only harmless warnings
```

### 7. Run Regression Tests

**Manual regression test checklist:**

Via LINE channel (send these messages and verify responses):

1. **Basic functionality:**
   ```
   สวัสดี
   ```
   Expected: Greeting response without errors

2. **Long response test (maxTokens):**
   ```
   อธิบาย quantum computing แบบละเอียดมาก ๆ ยาว ๆ
   ```
   Expected: Long detailed response (>4000 tokens) without truncation

3. **Web search test:**
   ```
   ค้นหาราคาทองวันนี้
   ```
   Expected: Current gold prices from web search

4. **Model info (sessionId guard):**
   ```
   ใช้ model อะไรอยู่
   ```
   Expected: "openrouter/google/gemini-2.5-flash" (no "Unknown sessionId" error)

5. **Fallback test (optional - requires breaking primary model):**
   ```
   ทดสอบ fallback
   ```
   Expected: Response from fallback model if primary unavailable

**Automated regression tests (future):**

```bash
# Run smoke tests from CLI
pnpm test:docker:live-gateway

# Run full integration tests
pnpm test:docker:onboard
```

### 8. Update Release Documentation

**Update `README.md` release section:**

```markdown
## Releases

### v2026.2.27 (Latest)

**Release Notes:**
- **Fix:** Increased maxTokens from 4096 to 16384 for long responses
- **Feature:** Added 3-tier model fallback chain with free tier safety net
- **Feature:** Integrated Brave Search for web queries
- **Fix:** Added TOOLS.md guard against sessionId errors in LINE channel
- **Infra:** Updated Nginx LINE location timeout to 120s

**Deployment:**
- Docker image: `piboonsak/openclaw:latest`
- Deployed: 2026-02-27
- VPS: openclaw.yahwan.biz (76.13.210.250)

**Known Issues:**
- None

**Upgrade Instructions:**
```bash
docker pull piboonsak/openclaw:latest
docker-compose down && docker-compose up -d
```
```

**Commit the release notes:**

```bash
git add README.md
git commit -m "docs: update release notes for v2026.2.27"
git push origin main
```

---

## Emergency Procedures

### Rollback to Previous Version

```bash
# SSH into VPS
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@76.13.210.250

# Pull previous working image
docker pull piboonsak/openclaw:v2026.2.22

# Update docker-compose.yml to use specific tag
cd /root/openclaw-deployment
nano docker/docker-compose.prod.yml  # Change image: to specific version

# Restart with old version
docker-compose -f docker/docker-compose.prod.yml down
docker-compose -f docker/docker-compose.prod.yml up -d

# Verify health
docker ps
docker logs openclaw-sgnl-openclaw-1 --tail 50
```

### When VPS Crashes/Needs Rebuild

If VPS is completely lost, redeploy from clean slate:

```bash
# 1. SSH into new VPS
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@<NEW_IP>

# 2. Clone deployment repo
git clone https://github.com/Piboonsak/openclaw_github.git /root/openclaw-deployment
cd /root/openclaw-deployment

# 3. Run setup script
bash docker/vps-setup.sh

# 4. Configure environment variables in Hostinger UI
# (all OPENROUTER_API_KEY, BRAVE_API_KEY, etc.)

# 5. Deploy with docker-compose
docker-compose -f docker/docker-compose.prod.yml up -d

# 6. Verify using health checks above
```

---

## Quick Reference

### File Locations

**Local (development):**
- Config: `config/openclaw.prod.json5`
- Docker Compose: `docker/docker-compose.prod.yml`
- Nginx: `docker/nginx/openclaw.conf`
- VPS Setup: `docker/vps-setup.sh`

**VPS (production):**
- Container: `openclaw-sgnl-openclaw-1`
- Config: `/data/.openclaw/openclaw.json` (inside container)
- Workspace: `/data/openclaw/workspace/` (Docker volume)
- Logs: `docker logs openclaw-sgnl-openclaw-1`

### Key Commands

```bash
# Check container status
docker ps --filter name=openclaw

# View logs (live)
docker logs -f openclaw-sgnl-openclaw-1

# Restart container
docker restart openclaw-sgnl-openclaw-1

# Execute command inside container
docker exec openclaw-sgnl-openclaw-1 openclaw --version

# Check gateway health
docker exec openclaw-sgnl-openclaw-1 openclaw channels status --probe
```

### Environment Variables (Hostinger UI)

Required for production:
- `OPENROUTER_API_KEY` - Primary LLM provider
- `BRAVE_API_KEY` - Web search (code expects this exact name)
- `BRAVE_API_SEARCH_KEY` - Alternative Brave key
- `BRAVE_API_ANSWER_KEY` - Brave AI answers
- `LINE_CHANNEL_SECRET` - LINE bot authentication
- `LINE_CHANNEL_ACCESS_TOKEN` - LINE bot access

---

## Change Log

| Date | Commit | Changes | Tag | Status |
|------|--------|---------|-----|--------|
| 2026-02-27 | `e8f5f37` | Naming conventions: aligned Git tag == image tag | `docs` | ✅ Merged |
| 2026-02-27 | `cec2aac` | Config: wire Brave Search apiKey via env substitution | `config` | ✅ Deployed |
| 2026-02-27 | `ab08d4b` | WS-2.2 fixes: Gemini Flash primary, fallback chain, Brave Search, maxTokens 16384 | `v2026.2.27-ws22` | ✅ Deployed |

---

## Notes

- **Always test locally** before pushing to production
- **Document breaking changes** in commit messages
- **Keep Docker Hub and GitHub in sync** (same version tags)
- **Monitor logs** for 10 minutes after deployment
- **Have rollback plan ready** before major changes

---

## Future Improvements

- [ ] Setup GitHub Actions for automated build/deploy
- [ ] Add automated regression test suite
- [ ] Setup monitoring/alerting (UptimeRobot, Sentry)
- [ ] Add staging environment for pre-production testing
- [ ] Setup blue-green deployment for zero-downtime updates
- [ ] Add health check webhook to notify on failures
