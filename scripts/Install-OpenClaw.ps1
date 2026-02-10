<#
.SYNOPSIS
    Install OpenClaw with Claude + Google Gemini dual-AI provider support
    and Google Workspace integration for PowerShell.

.DESCRIPTION
    This script installs OpenClaw into your local PowerShell environment,
    configures both Anthropic Claude and Google Gemini as AI providers,
    sets up Google Workspace integration (Gmail, Google Chat), and adds
    PowerShell profile functions for seamless AI interaction.

.PARAMETER InstallMethod
    Installation method: "npm" (default) or "git".

.PARAMETER SkipNodeCheck
    Skip the Node.js version check.

.PARAMETER SkipProfile
    Skip PowerShell profile integration (module import, aliases).

.PARAMETER SkipProviderSetup
    Skip the dual-provider (Claude + Gemini) configuration step.

.PARAMETER AnthropicApiKey
    Anthropic API key for Claude. Can also be set via ANTHROPIC_API_KEY env var.

.PARAMETER GoogleApiKey
    Google Gemini API key. Can also be set via GEMINI_API_KEY or GOOGLE_API_KEY env var.

.PARAMETER EnableGmailHooks
    Enable Gmail webhook integration for Google Workspace.

.PARAMETER GmailAccount
    Gmail account email for hook integration.

.PARAMETER ConfigDir
    Override the OpenClaw state directory (default: ~/.openclaw).

.PARAMETER DryRun
    Show what would be done without making changes.

.EXAMPLE
    .\Install-OpenClaw.ps1
    # Default install with interactive provider setup

.EXAMPLE
    .\Install-OpenClaw.ps1 -AnthropicApiKey "sk-ant-..." -GoogleApiKey "AIza..."
    # Non-interactive install with API keys

.EXAMPLE
    .\Install-OpenClaw.ps1 -EnableGmailHooks -GmailAccount "you@gmail.com"
    # Install with Gmail workspace integration
#>

[CmdletBinding()]
param(
    [ValidateSet("npm", "git")]
    [string]$InstallMethod = "npm",

    [switch]$SkipNodeCheck,
    [switch]$SkipProfile,
    [switch]$SkipProviderSetup,
    [string]$AnthropicApiKey,
    [string]$GoogleApiKey,
    [switch]$EnableGmailHooks,
    [string]$GmailAccount,
    [string]$ConfigDir,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Constants ──────────────────────────────────────────────────────────

$MIN_NODE_MAJOR = 22
$OPENCLAW_STATE_DIR = if ($ConfigDir) { $ConfigDir } else {
    if ($env:OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR }
    else { Join-Path $HOME ".openclaw" }
}
$CONFIG_PATH = Join-Path $OPENCLAW_STATE_DIR "openclaw.json"
$MODULE_DIR = Join-Path $OPENCLAW_STATE_DIR "powershell"
$MODULE_FILE = Join-Path $MODULE_DIR "OpenClawAI.psm1"

# ── Helpers ────────────────────────────────────────────────────────────

function Write-Step {
    param([string]$Message)
    Write-Host "[openclaw] " -ForegroundColor Cyan -NoNewline
    Write-Host $Message
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[openclaw] " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Err {
    param([string]$Message)
    Write-Host "[openclaw] " -ForegroundColor Red -NoNewline
    Write-Host $Message
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[openclaw] " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Test-CommandExists {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

# ── 1. Node.js Check ──────────────────────────────────────────────────

function Assert-NodeInstalled {
    if ($SkipNodeCheck) {
        Write-Step "Skipping Node.js check"
        return
    }

    Write-Step "Checking Node.js installation..."

    if (-not (Test-CommandExists "node")) {
        Write-Err "Node.js is not installed. OpenClaw requires Node.js >= $MIN_NODE_MAJOR."
        Write-Host ""
        Write-Host "  Install Node.js using one of:"
        Write-Host "    winget install OpenJS.NodeJS.LTS"
        Write-Host "    choco install nodejs-lts"
        Write-Host "    scoop install nodejs-lts"
        Write-Host ""
        throw "Node.js not found"
    }

    $nodeVersion = (node --version) -replace '^v', ''
    $major = [int]($nodeVersion -split '\.')[0]

    if ($major -lt $MIN_NODE_MAJOR) {
        Write-Err "Node.js $nodeVersion found, but >= $MIN_NODE_MAJOR is required."
        throw "Node.js version too old"
    }

    Write-Ok "Node.js $nodeVersion detected"
}

# ── 2. Install OpenClaw ───────────────────────────────────────────────

function Install-OpenClawPackage {
    Write-Step "Installing OpenClaw via $InstallMethod..."

    if ($DryRun) {
        Write-Step "[DRY RUN] Would install openclaw via $InstallMethod"
        return
    }

    if (Test-CommandExists "openclaw") {
        $currentVersion = & openclaw --version 2>$null
        Write-Ok "OpenClaw already installed: $currentVersion"
        Write-Step "Upgrading to latest..."
    }

    switch ($InstallMethod) {
        "npm" {
            if (Test-CommandExists "pnpm") {
                & pnpm add -g openclaw@latest
            } elseif (Test-CommandExists "npm") {
                & npm install -g openclaw@latest
            } else {
                Write-Err "Neither npm nor pnpm found. Install Node.js first."
                throw "Package manager not found"
            }
        }
        "git" {
            $gitDir = Join-Path $HOME "openclaw"
            if (Test-Path $gitDir) {
                Write-Step "Updating existing git clone at $gitDir..."
                Push-Location $gitDir
                & git pull origin main
                & npm install
                & npm run build
                Pop-Location
            } else {
                Write-Step "Cloning openclaw to $gitDir..."
                & git clone https://github.com/nicepkg/openclaw.git $gitDir
                Push-Location $gitDir
                & npm install
                & npm run build
                Pop-Location
            }
        }
    }

    Write-Ok "OpenClaw installed successfully"
}

# ── 3. Create State Directory ─────────────────────────────────────────

function Initialize-StateDirectory {
    Write-Step "Initializing state directory at $OPENCLAW_STATE_DIR..."

    if ($DryRun) {
        Write-Step "[DRY RUN] Would create $OPENCLAW_STATE_DIR"
        return
    }

    if (-not (Test-Path $OPENCLAW_STATE_DIR)) {
        New-Item -ItemType Directory -Path $OPENCLAW_STATE_DIR -Force | Out-Null
    }

    # Create subdirectories
    $subdirs = @("credentials", "completions", "powershell", "logs")
    foreach ($dir in $subdirs) {
        $path = Join-Path $OPENCLAW_STATE_DIR $dir
        if (-not (Test-Path $path)) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
        }
    }

    Write-Ok "State directory ready"
}

# ── 4. Configure Dual AI Providers ───────────────────────────────────

function Set-DualProviderConfig {
    if ($SkipProviderSetup) {
        Write-Step "Skipping provider setup"
        return
    }

    Write-Step "Configuring Claude + Gemini dual-provider setup..."

    # Resolve API keys from params or environment
    $claudeKey = if ($AnthropicApiKey) { $AnthropicApiKey }
                 elseif ($env:ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY }
                 else { $null }

    $geminiKey = if ($GoogleApiKey) { $GoogleApiKey }
                 elseif ($env:GEMINI_API_KEY) { $env:GEMINI_API_KEY }
                 elseif ($env:GOOGLE_API_KEY) { $env:GOOGLE_API_KEY }
                 else { $null }

    # Load existing config or create new
    $config = @{}
    if (Test-Path $CONFIG_PATH) {
        $config = Get-Content $CONFIG_PATH -Raw | ConvertFrom-Json -AsHashtable
    }

    # Ensure nested structure
    if (-not $config.ContainsKey("models")) { $config["models"] = @{} }
    if (-not $config["models"].ContainsKey("providers")) { $config["models"]["providers"] = @{} }
    if (-not $config.ContainsKey("agents")) { $config["agents"] = @{} }
    if (-not $config["agents"].ContainsKey("defaults")) { $config["agents"]["defaults"] = @{} }
    if (-not $config["agents"]["defaults"].ContainsKey("models")) { $config["agents"]["defaults"]["models"] = @{} }

    # ── Anthropic Claude Provider ──
    $claudeProvider = @{
        apiKey = if ($claudeKey) { $claudeKey } else { "ANTHROPIC_API_KEY" }
        models = @(
            @{
                id = "claude-opus-4-6"
                name = "Claude Opus 4.6"
                reasoning = $true
                input = @("text", "image", "pdf")
                contextWindow = 200000
                maxTokens = 32768
            },
            @{
                id = "claude-sonnet-4-5"
                name = "Claude Sonnet 4.5"
                reasoning = $true
                input = @("text", "image", "pdf")
                contextWindow = 200000
                maxTokens = 16384
            }
        )
    }
    $config["models"]["providers"]["anthropic"] = $claudeProvider

    # ── Google Gemini Provider ──
    $geminiProvider = @{
        apiKey = if ($geminiKey) { $geminiKey } else { "GEMINI_API_KEY" }
        baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai"
        models = @(
            @{
                id = "gemini-3-pro-preview"
                name = "Gemini 3 Pro"
                reasoning = $true
                input = @("text", "image", "audio", "video", "pdf")
                contextWindow = 1000000
                maxTokens = 65536
            },
            @{
                id = "gemini-3-flash-preview"
                name = "Gemini 3 Flash"
                reasoning = $false
                input = @("text", "image", "audio", "video", "pdf")
                contextWindow = 1000000
                maxTokens = 65536
            }
        )
    }
    $config["models"]["providers"]["google"] = $geminiProvider

    # Set default model references for both providers
    $config["agents"]["defaults"]["models"]["anthropic/claude-opus-4-6"] = @{}
    $config["agents"]["defaults"]["models"]["google/gemini-3-pro-preview"] = @{}

    # ── Gmail Hooks (Google Workspace) ──
    if ($EnableGmailHooks) {
        Write-Step "Configuring Gmail webhook integration..."
        if (-not $config.ContainsKey("hooks")) { $config["hooks"] = @{} }

        $config["hooks"]["enabled"] = $true

        $gmailConfig = @{
            label = "INBOX"
            topic = "gog-gmail-watch"
            subscription = "gog-gmail-watch-push"
            includeBody = $true
            maxBytes = 20000
            renewEveryMinutes = 720
        }

        if ($GmailAccount) {
            $gmailConfig["account"] = $GmailAccount
        }

        $config["hooks"]["gmail"] = $gmailConfig

        # Add Gmail hook mapping
        if (-not $config["hooks"].ContainsKey("mappings")) {
            $config["hooks"]["mappings"] = @()
        }

        $gmailMapping = @{
            id = "gmail-workspace"
            match = @{ source = "gmail" }
            action = "agent"
            name = "Gmail Workspace Handler"
            messageTemplate = "New email from {{from}}: {{subject}}"
            model = "google/gemini-3-flash-preview"
        }

        $config["hooks"]["mappings"] += $gmailMapping

        # Enable hooks presets
        if (-not $config["hooks"].ContainsKey("presets")) {
            $config["hooks"]["presets"] = @()
        }
        if ("gmail" -notin $config["hooks"]["presets"]) {
            $config["hooks"]["presets"] += "gmail"
        }

        Write-Ok "Gmail hooks configured"
    }

    # Write config
    if ($DryRun) {
        Write-Step "[DRY RUN] Would write config to $CONFIG_PATH"
        Write-Host ($config | ConvertTo-Json -Depth 10)
        return
    }

    $config | ConvertTo-Json -Depth 10 | Set-Content -Path $CONFIG_PATH -Encoding UTF8
    Write-Ok "Configuration saved to $CONFIG_PATH"

    # Print status
    if ($claudeKey) {
        Write-Ok "Anthropic Claude: API key configured"
    } else {
        Write-Warn "Anthropic Claude: Set ANTHROPIC_API_KEY env var or run: openclaw models auth anthropic"
    }

    if ($geminiKey) {
        Write-Ok "Google Gemini: API key configured"
    } else {
        Write-Warn "Google Gemini: Set GEMINI_API_KEY env var or run: openclaw models auth google"
    }
}

# ── 5. Install PowerShell Module ──────────────────────────────────────

function Install-PowerShellModule {
    if ($SkipProfile) {
        Write-Step "Skipping PowerShell profile integration"
        return
    }

    Write-Step "Installing OpenClaw PowerShell module..."

    if ($DryRun) {
        Write-Step "[DRY RUN] Would install module to $MODULE_FILE"
        return
    }

    # Copy the module file
    $sourceModule = Join-Path $PSScriptRoot "powershell" "OpenClawAI.psm1"
    if (-not (Test-Path $sourceModule)) {
        # Try relative to the repo root
        $sourceModule = Join-Path (Split-Path $PSScriptRoot -Parent) "scripts" "powershell" "OpenClawAI.psm1"
    }

    if (Test-Path $sourceModule) {
        if (-not (Test-Path $MODULE_DIR)) {
            New-Item -ItemType Directory -Path $MODULE_DIR -Force | Out-Null
        }
        Copy-Item $sourceModule $MODULE_FILE -Force
    } else {
        Write-Warn "Module source not found at $sourceModule — skipping module copy"
        Write-Warn "The module will be generated during the build step"
        return
    }

    # Add to PowerShell profile
    $profilePath = $PROFILE.CurrentUserAllHosts
    if (-not $profilePath) {
        $profilePath = $PROFILE
    }

    $profileDir = Split-Path $profilePath -Parent
    if (-not (Test-Path $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }

    if (-not (Test-Path $profilePath)) {
        New-Item -ItemType File -Path $profilePath -Force | Out-Null
    }

    $importLine = "Import-Module `"$MODULE_FILE`" -ErrorAction SilentlyContinue"
    $header = "# OpenClaw AI Integration (Claude + Gemini)"
    $profileContent = Get-Content $profilePath -Raw -ErrorAction SilentlyContinue

    if ($profileContent -and $profileContent.Contains("OpenClawAI")) {
        Write-Step "Module already referenced in profile, updating..."
        # Remove old block
        $lines = $profileContent -split "`n"
        $filtered = @()
        $skipNext = $false
        foreach ($line in $lines) {
            if ($line.Trim() -eq $header) {
                $skipNext = $true
                continue
            }
            if ($skipNext -and $line.Contains("OpenClawAI")) {
                $skipNext = $false
                continue
            }
            $skipNext = $false
            $filtered += $line
        }
        $profileContent = ($filtered -join "`n").TrimEnd()
    }

    $block = @"

$header
$importLine
"@

    if ($profileContent) {
        $newContent = $profileContent.TrimEnd() + "`n" + $block + "`n"
    } else {
        $newContent = $block + "`n"
    }

    Set-Content -Path $profilePath -Value $newContent -Encoding UTF8
    Write-Ok "Profile updated: $profilePath"
    Write-Step "Restart PowerShell or run: . `$PROFILE"
}

# ── 6. Run onboard ───────────────────────────────────────────────────

function Start-Onboard {
    if ($DryRun) {
        Write-Step "[DRY RUN] Would run: openclaw doctor --non-interactive"
        return
    }

    if (Test-CommandExists "openclaw") {
        Write-Step "Running OpenClaw diagnostics..."
        & openclaw doctor --non-interactive 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Diagnostics passed"
        } else {
            Write-Warn "Some diagnostics had warnings — run 'openclaw doctor' for details"
        }
    }
}

# ── Main ──────────────────────────────────────────────────────────────

function Main {
    Write-Host ""
    Write-Host "  OpenClaw AI Installer for PowerShell" -ForegroundColor Cyan
    Write-Host "  Claude + Google Gemini | Google Workspace" -ForegroundColor DarkCyan
    Write-Host ""

    Assert-NodeInstalled
    Install-OpenClawPackage
    Initialize-StateDirectory
    Set-DualProviderConfig
    Install-PowerShellModule
    Start-Onboard

    Write-Host ""
    Write-Ok "Installation complete!"
    Write-Host ""
    Write-Host "  Quick start:" -ForegroundColor Cyan
    Write-Host "    openclaw               # Start the AI gateway"
    Write-Host "    openclaw gateway       # Run in gateway mode"
    Write-Host "    Ask-Claude 'hello'     # Chat with Claude"
    Write-Host "    Ask-Gemini 'hello'     # Chat with Gemini"
    Write-Host "    Ask-AI 'hello'         # Chat with default provider"
    Write-Host ""
    Write-Host "  Google Workspace:" -ForegroundColor Cyan
    Write-Host "    openclaw models auth google    # Authenticate with Google"
    Write-Host "    Connect-GoogleWorkspace        # Setup Gmail + Google Chat"
    Write-Host ""
    Write-Host "  Configuration:" -ForegroundColor Cyan
    Write-Host "    Config:  $CONFIG_PATH"
    Write-Host "    State:   $OPENCLAW_STATE_DIR"
    Write-Host "    Profile: $($PROFILE.CurrentUserAllHosts)"
    Write-Host ""
}

Main
