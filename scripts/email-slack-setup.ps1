# Email → Slack + Auto-Reply  |  PowerShell Setup (Windows)
# ─────────────────────────────────────────────────────────
# Usage (from repo root in PowerShell):
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser  # once
#   .\scripts\email-slack-setup.ps1
#
# Requires: Docker Desktop for Windows (with docker compose v2)
# ─────────────────────────────────────────────────────────

param (
    [string]$EnvFile = ".\.env.email-digest",
    [string]$ComposeFile = ".\docker-compose.email-digest.yml"
)

$ErrorActionPreference = "Stop"

function Write-Header  { param([string]$t) Write-Host "`n$('─'*52)`n  $t`n$('─'*52)" -ForegroundColor Cyan }
function Write-Info    { param([string]$t) Write-Host "  ▶ $t" -ForegroundColor Blue }
function Write-Success { param([string]$t) Write-Host "  ✓ $t" -ForegroundColor Green }
function Write-Warn    { param([string]$t) Write-Host "  ⚠ $t" -ForegroundColor Yellow }
function Write-Fail    { param([string]$t) Write-Host "  ✗ $t" -ForegroundColor Red }

Write-Host ""
Write-Host "  📬  OpenClaw Email → Slack + Auto-Reply  |  Windows Setup" -ForegroundColor Cyan -BackgroundColor DarkBlue
Write-Host "       Gmail polling every hour · Slack notifications · Auto-acknowledge"
Write-Host ""

# ─── Step 1: Check Docker ────────────────────────────────────────────────────
Write-Header "Step 1: Checking prerequisites"

try {
    $dv = docker --version 2>&1
    Write-Success "Docker: $dv"
} catch {
    Write-Fail "Docker is not installed."
    Write-Host "  Install Docker Desktop from: https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Yellow
    exit 1
}

try {
    $dcv = docker compose version 2>&1
    Write-Success "Docker Compose: $dcv"
} catch {
    Write-Fail "Docker Compose v2 not found. Make sure Docker Desktop is up to date."
    exit 1
}

# ─── Step 2: Load existing env file ─────────────────────────────────────────
Write-Header "Step 2: Configuration"

$cfg = @{}

if (Test-Path $EnvFile) {
    Write-Info "Loading existing $EnvFile"
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') {
            $cfg[$matches[1].Trim()] = $matches[2].Trim()
        }
    }
}

function Prompt-If-Empty {
    param([string]$Key, [string]$Prompt, [string]$Default = "")
    if (-not $cfg[$Key]) {
        $val = Read-Host $Prompt
        if (-not $val -and $Default) { $val = $Default }
        $cfg[$Key] = $val
    }
}

# Generate gateway token if missing
if (-not $cfg["OPENCLAW_GATEWAY_TOKEN"]) {
    $cfg["OPENCLAW_GATEWAY_TOKEN"] = -join ((48..57 + 97..102) * 4 | Get-Random -Count 64 | ForEach-Object { [char]$_ })
    Write-Info "Generated gateway token"
}

Prompt-If-Empty "GOG_ACCOUNT"           "  📧  Gmail address (e.g. you@gmail.com)"
Prompt-If-Empty "ANTHROPIC_API_KEY"     "  🤖  Anthropic API key (sk-ant-..., or blank to skip)"

if (-not $cfg["SLACK_BOT_TOKEN"]) {
    Write-Host ""
    Write-Host "  To get a Slack Bot Token:" -ForegroundColor Cyan
    Write-Host "    1. https://api.slack.com/apps → Create New App → From Scratch"
    Write-Host "    2. OAuth & Permissions → Bot Token Scopes: chat:write, channels:read"
    Write-Host "    3. Install to workspace → copy 'Bot User OAuth Token' (xoxb-...)"
    Write-Host ""
    Prompt-If-Empty "SLACK_BOT_TOKEN"   "  💬  Slack Bot Token (xoxb-...)"
}

if ($cfg["SLACK_BOT_TOKEN"] -and -not $cfg["DIGEST_SLACK_CHANNEL"]) {
    Write-Host ""
    Write-Host "  Channel ID: right-click channel → View channel details → copy ID (C0123456789)" -ForegroundColor Cyan
    Write-Host ""
    Prompt-If-Empty "DIGEST_SLACK_CHANNEL" "  #  Slack Channel ID (e.g. C0123456789)"
}

if (-not $cfg.ContainsKey("EMAIL_AUTOREPLY_ENABLED")) {
    $ar = Read-Host "  📨  Enable auto-reply to new emails? (yes/no) [yes]"
    if (-not $ar -or $ar -match '^[Yy]') {
        $cfg["EMAIL_AUTOREPLY_ENABLED"] = "true"
        $cfg["EMAIL_AUTOREPLY_FROM"]    = $cfg["GOG_ACCOUNT"]
    } else {
        $cfg["EMAIL_AUTOREPLY_ENABLED"] = "false"
        $cfg["EMAIL_AUTOREPLY_FROM"]    = ""
    }
}

# Set defaults
$openclaw_cfg_dir = if ($cfg["OPENCLAW_CONFIG_DIR"]) { $cfg["OPENCLAW_CONFIG_DIR"] } else { "$env:USERPROFILE\.openclaw" }
$openclaw_ws_dir  = if ($cfg["OPENCLAW_WORKSPACE_DIR"]) { $cfg["OPENCLAW_WORKSPACE_DIR"] } else { "$openclaw_cfg_dir\workspace" }
$digest_dir       = if ($cfg["DIGEST_DIR"]) { $cfg["DIGEST_DIR"] } else { "$openclaw_cfg_dir\digests" }
$gog_cfg_dir      = if ($cfg["GOG_CONFIG_DIR"]) { $cfg["GOG_CONFIG_DIR"] } else { "$env:USERPROFILE\.config\gog" }

$cfg["OPENCLAW_CONFIG_DIR"]    = $openclaw_cfg_dir
$cfg["OPENCLAW_WORKSPACE_DIR"] = $openclaw_ws_dir
$cfg["DIGEST_DIR"]             = $digest_dir
$cfg["GOG_CONFIG_DIR"]         = $gog_cfg_dir
$cfg["OPENCLAW_GATEWAY_PORT"]  = if ($cfg["OPENCLAW_GATEWAY_PORT"]) { $cfg["OPENCLAW_GATEWAY_PORT"] } else { "18789" }
$cfg["OPENCLAW_BRIDGE_PORT"]   = if ($cfg["OPENCLAW_BRIDGE_PORT"])  { $cfg["OPENCLAW_BRIDGE_PORT"]  } else { "18790" }

Write-Success "Configuration collected"

# ─── Step 3: Create directories ──────────────────────────────────────────────
Write-Header "Step 3: Creating directories"

@($openclaw_cfg_dir, $openclaw_ws_dir, $digest_dir, $gog_cfg_dir) | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
    Write-Success "Ready: $_"
}

# ─── Step 4: Write .env.email-digest ─────────────────────────────────────────
Write-Header "Step 4: Writing $EnvFile"

$envLines = @(
    "# OpenClaw — Email → Slack + Auto-Reply",
    "# Generated by scripts/email-slack-setup.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
    "# Edit this file then restart: docker compose -f $ComposeFile --env-file $EnvFile restart",
    "",
    "# ── Paths ───────────────────────────────────────────────────────────────────",
    "OPENCLAW_CONFIG_DIR=$($cfg['OPENCLAW_CONFIG_DIR'])",
    "OPENCLAW_WORKSPACE_DIR=$($cfg['OPENCLAW_WORKSPACE_DIR'])",
    "DIGEST_DIR=$($cfg['DIGEST_DIR'])",
    "GOG_CONFIG_DIR=$($cfg['GOG_CONFIG_DIR'])",
    "",
    "# ── Ports ───────────────────────────────────────────────────────────────────",
    "OPENCLAW_GATEWAY_PORT=$($cfg['OPENCLAW_GATEWAY_PORT'])",
    "OPENCLAW_BRIDGE_PORT=$($cfg['OPENCLAW_BRIDGE_PORT'])",
    "",
    "# ── Auth ────────────────────────────────────────────────────────────────────",
    "OPENCLAW_GATEWAY_TOKEN=$($cfg['OPENCLAW_GATEWAY_TOKEN'])",
    "",
    "# ── AI Model API keys ────────────────────────────────────────────────────────",
    "ANTHROPIC_API_KEY=$($cfg['ANTHROPIC_API_KEY'])",
    "OPENAI_API_KEY=$($cfg['OPENAI_API_KEY'])",
    "CLAUDE_AI_SESSION_KEY=$($cfg['CLAUDE_AI_SESSION_KEY'])",
    "CLAUDE_WEB_SESSION_KEY=$($cfg['CLAUDE_WEB_SESSION_KEY'])",
    "CLAUDE_WEB_COOKIE=$($cfg['CLAUDE_WEB_COOKIE'])",
    "",
    "# ── Gmail ───────────────────────────────────────────────────────────────────",
    "GOG_ACCOUNT=$($cfg['GOG_ACCOUNT'])",
    "",
    "# ── Slack ───────────────────────────────────────────────────────────────────",
    "SLACK_BOT_TOKEN=$($cfg['SLACK_BOT_TOKEN'])",
    "DIGEST_SLACK_CHANNEL=$($cfg['DIGEST_SLACK_CHANNEL'])",
    "",
    "# ── Auto-reply ──────────────────────────────────────────────────────────────",
    "EMAIL_AUTOREPLY_ENABLED=$($cfg['EMAIL_AUTOREPLY_ENABLED'])",
    "EMAIL_AUTOREPLY_FROM=$($cfg['EMAIL_AUTOREPLY_FROM'])",
    "",
    "# ── Other delivery channels (optional) ──────────────────────────────────────",
    "DIGEST_WHATSAPP_NUMBER=$($cfg['DIGEST_WHATSAPP_NUMBER'])",
    "DIGEST_TELEGRAM_CHAT=$($cfg['DIGEST_TELEGRAM_CHAT'])"
)
$envLines | Set-Content -Path $EnvFile -Encoding UTF8
Write-Success "Wrote $EnvFile"

# ─── Step 5: Build Docker images ─────────────────────────────────────────────
Write-Header "Step 5: Building Docker images (first run takes ~5-10 min)"

Write-Info "Building openclaw:local..."
docker build -t openclaw:local .
Write-Success "openclaw:local built"

Write-Info "Building openclaw:email-digest (adds gog + jq)..."
docker build -f Dockerfile.email-digest -t openclaw:email-digest .
Write-Success "openclaw:email-digest built"

# ─── Step 6: Start the stack ─────────────────────────────────────────────────
Write-Header "Step 6: Starting the stack"

docker compose --env-file $EnvFile -f $ComposeFile up -d
Write-Success "Stack started"

Write-Info "Waiting for gateway to become healthy..."
$waited = 0; $healthy = $false
while ($waited -lt 60) {
    try {
        $resp = docker exec openclaw-email-digest curl -sf http://localhost:18789/health 2>&1
        if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    } catch {}
    Start-Sleep 3; $waited += 3
}
if ($healthy) { Write-Success "Gateway is healthy" }
else { Write-Warn "Gateway health check timed out — it may still be starting" }

# ─── Step 7: Connect Slack ───────────────────────────────────────────────────
Write-Header "Step 7: Connecting Slack"

if ($cfg["SLACK_BOT_TOKEN"]) {
    try {
        docker exec openclaw-email-digest node openclaw.mjs channels add --channel slack --token $cfg["SLACK_BOT_TOKEN"]
        Write-Success "Slack connected"
    } catch {
        Write-Warn "Could not connect Slack automatically. Run manually: docker exec -it openclaw-email-digest node openclaw.mjs channels add --channel slack --token <TOKEN>"
    }
} else {
    Write-Warn "SLACK_BOT_TOKEN not set — skipping Slack connection"
}

# ─── Step 8: Gmail auth ──────────────────────────────────────────────────────
Write-Header "Step 8: Gmail authentication (interactive)"

Write-Host "  A browser tab will open for Google OAuth. Sign in and grant access." -ForegroundColor Cyan
Write-Host ""
docker exec -it openclaw-email-digest gog auth add $cfg["GOG_ACCOUNT"] --services gmail,calendar
Write-Success "Gmail authenticated (or check output above)"

# ─── Step 9: Register cron ───────────────────────────────────────────────────
Write-Header "Step 9: Registering hourly cron job"

$deliverTo  = @()
if ($cfg["DIGEST_SLACK_CHANNEL"])   { $deliverTo += "Slack channel $($cfg['DIGEST_SLACK_CHANNEL'])" }
if ($cfg["DIGEST_WHATSAPP_NUMBER"]) { $deliverTo += "WhatsApp $($cfg['DIGEST_WHATSAPP_NUMBER'])" }
if ($cfg["DIGEST_TELEGRAM_CHAT"])   { $deliverTo += "Telegram $($cfg['DIGEST_TELEGRAM_CHAT'])" }
$deliverStr = if ($deliverTo) { $deliverTo -join ", " } else { "web dashboard only" }

$cronMsg = "Run the email-digest skill. Gmail account: $($cfg['GOG_ACCOUNT']). Deliver digest to: $deliverStr. Save JSON to ~/.openclaw/digests/."
if ($cfg["EMAIL_AUTOREPLY_ENABLED"] -eq "true") { $cronMsg += " Auto-reply to new leads and customers is ENABLED." }

try {
    docker exec openclaw-email-digest node openclaw.mjs cron add --name "Hourly Email Digest" --schedule "0 * * * *" --message $cronMsg --session isolated
    Write-Success "Hourly cron job registered (runs every hour at :00)"
} catch {
    Write-Warn "Could not register cron automatically. Add it manually in the OpenClaw dashboard: http://localhost:$($cfg['OPENCLAW_GATEWAY_PORT'])"
}

# ─── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "$('─'*54)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  ✅  Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Gateway:    http://localhost:$($cfg['OPENCLAW_GATEWAY_PORT'])"
Write-Host "  Dashboard:  http://localhost:$($cfg['OPENCLAW_GATEWAY_PORT'])/digest"
Write-Host "  Config:     $EnvFile"
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor Cyan
Write-Host "    docker exec -it openclaw-email-digest node openclaw.mjs agent --message 'Run email-digest skill now'"
Write-Host "    docker compose -f $ComposeFile --env-file $EnvFile logs -f"
Write-Host "    docker exec openclaw-email-digest node openclaw.mjs cron list"
Write-Host "    docker compose -f $ComposeFile --env-file $EnvFile down"
Write-Host ""
Write-Host "$('─'*54)" -ForegroundColor Cyan
