# CI/CD Workflow - OpenClaw Production Deployment

## ⚠️ CRITICAL RULE

**NEVER SSH directly into VPS to fix issues.** All changes MUST go through this CI/CD pipeline to ensure:
- Changes are version-controlled
- Deployments are reproducible
- VPS crashes can be recovered
- Team members can review/audit changes

---

## Agent Execution Policy (Autonomous CI/CD)

**Purpose:** If an agent modifies application code or production config, it must run the full CI/CD flow automatically based on this document. Do not ask the user for steps that are already defined here.

**Trigger conditions (run CI/CD automatically):**
- Any change under `src/**`, `config/**`, `docker/**`, or `docs/CI-CD-WORKFLOW.md`
- Any change that affects production runtime behavior or deployment

**No-ask rule:**
- If the decision is already defined in this document (paths, commands, step order, skip rules), execute it without asking.
- Only ask if a choice is not covered anywhere in this document or is destructive/irreversible and not already approved.

**VPS-only changes (no repo update):**
- If you must change live config or workspace data on the VPS, still follow Steps 5 → 6 → 7 → 8 → 9.
- Skip Steps 1–4 only when there is no code or repo change.

**Non-Linux developers:**
- If Docker build/push is not available locally, skip Steps 3–4 and proceed to Step 5.

---

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

**Pre-deployment checklist:**

```bash
# 1. Verify environment variables are set
bash docker/scripts/check-env.sh
# Expected: "✓ All required environment variables set"

# 2. Run from repo root (where docker-compose.prod.yml lives)
cd d:\01_gitrepo\openclaw_github
```

**First-time deployment setup (v2026.2.27-ws23 or later):**

> **CRITICAL:** This deployment fixes a volume mount path bug. Previous deployments had config/sessions data on container's writable layer (lost on restart). New deployment persists to named volume at `/data/.openclaw/`.

```bash
# Optional: Backup existing config from old container (if upgrading from earlier version)
# This is only necessary if you have an existing deployment you want to preserve settings from
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@76.13.210.250 <<'BASH_COMMANDS'
  cd /docker/openclaw-sgnl
  docker compose --profile maintenance run --rm backup-config
  # Creates backup at ./backups/openclaw.json.<timestamp>
BASH_COMMANDS
```

**Manual deployment to production:**

```bash
# SSH into VPS
ssh -i "C:\Users\HP Probook 440 G8\.ssh\id_ed25519_hostinger" root@76.13.210.250

# Navigate to deployment directory (CORRECT PATH)
cd /docker/openclaw-sgnl

# Verify environment variables are set (via Hostinger UI or .env file):
# - OPENROUTER_API_KEY (required — LLM provider)
# - BRAVE_API_KEY (required — web search)
# - BRAVE_API_SEARCH_KEY (optional alternative)
# - BRAVE_API_ANSWER_KEY (optional alternative)
# - LINE_CHANNEL_SECRET (required if using LINE)
# - LINE_CHANNEL_ACCESS_TOKEN (required if using LINE)

# Stage 1: Pull latest Docker image
docker pull piboonsak/openclaw:latest

# For browser support (goldtraders.or.th price checking, etc.):
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 -f docker/Dockerfile.prod -t piboonsak/openclaw:latest .
# Then push to Docker Hub before pulling here.

# Stage 2: Backup current config before shutdown (optional but recommended)
docker compose --profile maintenance run --rm backup-config

# Stage 3: Clear stale LINE session history (prevents "learned helplessness" from old conversation history)
docker compose --profile maintenance run --rm clear-sessions

# Stage 4: Update and restart
docker compose down
docker compose up -d

# Verify health after restart (wait 30-40 seconds)
sleep 40
docker ps --filter name=openclaw --format "table {{.Names}}\t{{.Status}}"
# Expected: "Up 30 seconds (healthy)"

# Stage 5: Configure persistence-critical fixes (first deployment only)
# These set safe command allowlist and exec host for LINE channel
docker exec openclaw-sgnl-openclaw-1 node openclaw.mjs config set tools.exec.host gateway
docker compose restart

# Exit SSH
exit
```

**Note:** The VPS deployment directory is NOT a git clone. Code changes (from Step 2) don't automatically sync. Configuration is managed through:
- Hostinger UI (environment variables)
- Docker image tags in `docker-compose.yml`
- Volume mounts (via named volumes in docker-compose - persists across restarts)

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

### 9. Feedback & Documentation Review (Quality Gate)

**Purpose:** Continuously improve this CI/CD workflow based on real execution experience.

**Required Question (Ask after every pipeline run):**

> "Please summarize what you did when following this CI-CD workflow:
> 1. **What actually worked smoothly?** (which steps need no changes)
> 2. **What was unclear** when reading the document? (confusing wording, missing context, outdated paths)
> 3. **What needs to be added/fixed** in this document for the next deployment run to go even more smoothly?
> 4. **Specific improvements:** update CI-CD-WORKFLOW.md with exact details/corrections you discovered"

**Gate Condition (Repeating Policy):**

Repeat this step after every CI/CD pipeline execution until all of the following are true:
- ✅ Steps 1-8 complete without needing SSH workarounds
- ✅ No confusion about file paths or command syntax
- ✅ No "unknown" errors that aren't documented
- ✅ Document accurately reflects actual VPS setup
- ✅ Next developer can follow this doc end-to-end without questions

**When improvements are found:**

```bash
# Edit this file with discovered clarifications
nano docs/CI-CD-WORKFLOW.md

# Commit improvements
git add docs/CI-CD-WORKFLOW.md
git commit -m "docs: improve CI-CD clarity from [reason discovered]"
git push origin main
```

**Example improvements that were made from feedback:**

- Clarified `/docker/openclaw-sgnl/` (not `/root/openclaw-deployment`) ✅
- Fixed `docker compose` v2 syntax (not `docker-compose`) ✅
- Added skip instructions for non-Linux developers (Steps 3-4) ✅
- Added "Known Issues" for LINE channel warnings ✅
- Added Step 5a for Git tag creation timing ✅

**Expected outcome:** After 2-3 full deployments using this gate, document becomes solid and repeatable.

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
- Workspace: `/data/.openclaw/workspace/` (inside container)
- Sessions: `/data/.openclaw/agents/main/sessions/` (inside container)
- Logs: `docker logs openclaw-sgnl-openclaw-1`
- Clear sessions script: `docker/scripts/clear-sessions.sh`

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

# Clear stale LINE session history (run before deploy)
docker exec openclaw-sgnl-openclaw-1 bash /app/docker/scripts/clear-sessions.sh
# Or via compose profile:
# docker compose --profile maintenance run --rm clear-sessions
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
