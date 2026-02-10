<#
.SYNOPSIS
    Configure OpenClaw Google Workspace integration for PowerShell.

.DESCRIPTION
    Sets up the connection between OpenClaw and Google Workspace services:

    - Google Gemini API (for AI-powered processing)
    - Gmail Hooks (email notifications via Pub/Sub webhooks)
    - Google Chat channel (messaging integration)
    - Google OAuth authentication

    Prerequisites:
    - OpenClaw installed (run Install-OpenClaw.ps1 first)
    - A Google Cloud project with the following APIs enabled:
        * Gmail API
        * Generative Language API (Gemini)
        * Google Chat API (optional)
        * Cloud Pub/Sub API (for Gmail hooks)
    - A Google Workspace or Gmail account

.PARAMETER GmailAccount
    Your Gmail/Google Workspace email address.

.PARAMETER GoogleProjectId
    Google Cloud project ID for API access.

.PARAMETER AuthMethod
    Authentication method: "apikey" (default), "oauth", or "service-account".

.PARAMETER GeminiApiKey
    Gemini API key from Google AI Studio (for apikey auth method).

.PARAMETER EnableGmail
    Enable Gmail hook integration (default: true).

.PARAMETER EnableGoogleChat
    Enable Google Chat channel integration.

.PARAMETER GmailLabels
    Gmail labels to watch (default: "INBOX").

.PARAMETER HookModel
    Default AI model for processing Gmail hooks.
    Options: "anthropic/claude-sonnet-4-5", "google/gemini-3-flash-preview"

.PARAMETER DryRun
    Show what would be configured without writing changes.

.EXAMPLE
    .\Setup-GoogleWorkspace.ps1 -GmailAccount "you@gmail.com" -GeminiApiKey "AIza..."

.EXAMPLE
    .\Setup-GoogleWorkspace.ps1 -GmailAccount "you@company.com" -AuthMethod oauth -GoogleProjectId "my-project"

.EXAMPLE
    .\Setup-GoogleWorkspace.ps1 -GmailAccount "you@gmail.com" -EnableGoogleChat -HookModel "google/gemini-3-flash-preview"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$GmailAccount,

    [string]$GoogleProjectId,

    [ValidateSet("apikey", "oauth", "service-account")]
    [string]$AuthMethod = "apikey",

    [string]$GeminiApiKey,

    [bool]$EnableGmail = $true,

    [switch]$EnableGoogleChat,

    [string]$GmailLabels = "INBOX",

    [ValidateSet("anthropic/claude-sonnet-4-5", "google/gemini-3-flash-preview", "anthropic/claude-opus-4-6", "google/gemini-3-pro-preview")]
    [string]$HookModel = "google/gemini-3-flash-preview",

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths ──────────────────────────────────────────────────────

$StateDir = if ($env:OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR } else { Join-Path $HOME ".openclaw" }
$ConfigPath = Join-Path $StateDir "openclaw.json"

function Write-Step {
    param([string]$Message)
    Write-Host "[workspace] " -ForegroundColor Blue -NoNewline
    Write-Host $Message
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[workspace] " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[workspace] " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

# ── Load or create config ─────────────────────────────────────────────

$config = @{}
if (Test-Path $ConfigPath) {
    $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json -AsHashtable
}

# Ensure structure
$ensureKeys = @(
    @("models"),
    @("models", "providers"),
    @("agents"),
    @("agents", "defaults"),
    @("agents", "defaults", "models"),
    @("hooks"),
    @("hooks", "mappings"),
    @("hooks", "presets"),
    @("channels")
)

foreach ($keyPath in $ensureKeys) {
    $current = $config
    for ($i = 0; $i -lt $keyPath.Count; $i++) {
        $key = $keyPath[$i]
        if (-not $current.ContainsKey($key)) {
            if ($key -eq "mappings" -or $key -eq "presets") {
                $current[$key] = @()
            } else {
                $current[$key] = @{}
            }
        }
        $current = $current[$key]
    }
}

Write-Host ""
Write-Host "  Google Workspace Setup for OpenClaw" -ForegroundColor Blue
Write-Host "  Account: $GmailAccount" -ForegroundColor DarkBlue
Write-Host ""

# ── 1. Google Gemini Provider ─────────────────────────────────────────

Write-Step "Configuring Google Gemini provider..."

$resolvedKey = if ($GeminiApiKey) { $GeminiApiKey }
               elseif ($env:GEMINI_API_KEY) { $env:GEMINI_API_KEY }
               elseif ($env:GOOGLE_API_KEY) { $env:GOOGLE_API_KEY }
               else { "GEMINI_API_KEY" }

$config["models"]["providers"]["google"] = @{
    apiKey  = $resolvedKey
    baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai"
    models  = @(
        @{
            id            = "gemini-3-pro-preview"
            name          = "Gemini 3 Pro"
            reasoning     = $true
            input         = @("text", "image", "audio", "video", "pdf")
            contextWindow = 1000000
            maxTokens     = 65536
        },
        @{
            id            = "gemini-3-flash-preview"
            name          = "Gemini 3 Flash"
            reasoning     = $false
            input         = @("text", "image", "audio", "video", "pdf")
            contextWindow = 1000000
            maxTokens     = 65536
        }
    )
}

$config["agents"]["defaults"]["models"]["google/gemini-3-pro-preview"] = @{}
$config["agents"]["defaults"]["models"]["google/gemini-3-flash-preview"] = @{}

Write-Ok "Gemini provider configured"

# ── 2. Authentication ─────────────────────────────────────────────────

Write-Step "Setting up authentication ($AuthMethod)..."

switch ($AuthMethod) {
    "oauth" {
        Write-Step "OAuth will be initiated on first use."
        Write-Step "Run: openclaw models auth google-gemini-cli"

        if ($GoogleProjectId) {
            if (-not $config.ContainsKey("env")) { $config["env"] = @{} }
            if (-not $config["env"].ContainsKey("vars")) { $config["env"]["vars"] = @{} }
            $config["env"]["vars"]["GOOGLE_CLOUD_PROJECT"] = $GoogleProjectId
        }
    }
    "service-account" {
        Write-Warn "Service account auth requires GOOGLE_APPLICATION_CREDENTIALS env var"
        Write-Warn "Set it to the path of your service account JSON key file"

        if ($GoogleProjectId) {
            if (-not $config.ContainsKey("env")) { $config["env"] = @{} }
            if (-not $config["env"].ContainsKey("vars")) { $config["env"]["vars"] = @{} }
            $config["env"]["vars"]["GOOGLE_CLOUD_PROJECT"] = $GoogleProjectId
        }
    }
    "apikey" {
        if ($resolvedKey -eq "GEMINI_API_KEY") {
            Write-Warn "No API key provided. Set GEMINI_API_KEY or pass -GeminiApiKey"
            Write-Warn "Get a key at: https://aistudio.google.com/apikey"
        } else {
            Write-Ok "API key configured"
        }
    }
}

# ── 3. Gmail Hooks ────────────────────────────────────────────────────

if ($EnableGmail) {
    Write-Step "Configuring Gmail hooks for $GmailAccount..."

    $config["hooks"]["enabled"] = $true

    $config["hooks"]["gmail"] = @{
        account           = $GmailAccount
        label             = $GmailLabels
        topic             = "gog-gmail-watch"
        subscription      = "gog-gmail-watch-push"
        includeBody       = $true
        maxBytes          = 20000
        renewEveryMinutes = 720
    }

    # Add gmail preset if not present
    if ("gmail" -notin $config["hooks"]["presets"]) {
        $config["hooks"]["presets"] += "gmail"
    }

    # Gmail hook mappings
    $gmailMappings = @(
        @{
            id              = "gmail-inbox-handler"
            match           = @{ source = "gmail" }
            action          = "agent"
            name            = "Gmail Inbox Handler"
            messageTemplate = "New email from {{from}}: {{subject}}`n`n{{body}}"
            model           = $HookModel
        }
    )

    # Merge mappings (don't duplicate by id)
    $existingIds = @($config["hooks"]["mappings"] | ForEach-Object { $_.id })
    foreach ($mapping in $gmailMappings) {
        if ($mapping.id -notin $existingIds) {
            $config["hooks"]["mappings"] += $mapping
        }
    }

    Write-Ok "Gmail hooks configured"
    Write-Step "Gmail Pub/Sub setup requirements:"
    Write-Host "    1. Enable Gmail API in Google Cloud Console"
    Write-Host "    2. Enable Cloud Pub/Sub API"
    Write-Host "    3. Create topic: gog-gmail-watch"
    Write-Host "    4. Grant gmail-api-push@system.gserviceaccount.com publish rights"
    Write-Host "    5. Create push subscription pointing to your gateway"
    Write-Host ""
}

# ── 4. Google Chat Channel ────────────────────────────────────────────

if ($EnableGoogleChat) {
    Write-Step "Configuring Google Chat channel..."

    $config["channels"]["googlechat"] = @{
        enabled = $true
    }

    Write-Ok "Google Chat channel enabled"
    Write-Step "Complete Google Chat setup in Google Cloud Console:"
    Write-Host "    1. Enable Google Chat API"
    Write-Host "    2. Configure Chat app in API console"
    Write-Host "    3. Set the webhook URL to your gateway endpoint"
    Write-Host ""
}

# ── 5. Write Config ───────────────────────────────────────────────────

if ($DryRun) {
    Write-Step "[DRY RUN] Would write the following config:"
    $config | ConvertTo-Json -Depth 10
} else {
    $config | ConvertTo-Json -Depth 10 | Set-Content -Path $ConfigPath -Encoding UTF8
    Write-Ok "Configuration saved to $ConfigPath"
}

# ── Summary ───────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Setup Summary" -ForegroundColor Blue
Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkBlue
Write-Host "  Account:      $GmailAccount"
Write-Host "  Auth:         $AuthMethod"
Write-Host "  Gemini:       Configured (gemini-3-pro, gemini-3-flash)"
Write-Host "  Gmail Hooks:  $(if ($EnableGmail) { 'Enabled' } else { 'Disabled' })"
Write-Host "  Google Chat:  $(if ($EnableGoogleChat) { 'Enabled' } else { 'Disabled' })"
Write-Host "  Hook Model:   $HookModel"
Write-Host "  Config:       $ConfigPath"
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    1. Start the gateway:  openclaw gateway"
Write-Host "    2. Verify providers:   openclaw models list"
Write-Host "    3. Test Gemini:        Ask-Gemini 'Hello from PowerShell'"
Write-Host "    4. Test Claude:        Ask-Claude 'Hello from PowerShell'"
Write-Host ""
