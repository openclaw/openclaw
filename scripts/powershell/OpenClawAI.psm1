#Requires -Version 5.1
<#
.SYNOPSIS
    OpenClaw AI PowerShell module — Claude + Google Gemini dual-provider integration.

.DESCRIPTION
    Provides PowerShell functions and aliases for interacting with Anthropic Claude
    and Google Gemini through the OpenClaw AI gateway. Includes Google Workspace
    connectivity helpers for Gmail, Google Chat, and related services.

    This module is loaded automatically when installed via Install-OpenClaw.ps1.
#>

# ── Module State ───────────────────────────────────────────────────────

$script:OpenClawStateDir = if ($env:OPENCLAW_STATE_DIR) {
    $env:OPENCLAW_STATE_DIR
} else {
    Join-Path $HOME ".openclaw"
}

$script:OpenClawConfigPath = Join-Path $script:OpenClawStateDir "openclaw.json"
$script:DefaultProvider = "anthropic"
$script:DefaultModel = "claude-opus-4-6"
$script:GatewayPort = if ($env:OPENCLAW_GATEWAY_PORT) { $env:OPENCLAW_GATEWAY_PORT } else { 18789 }

# ── Core Functions ─────────────────────────────────────────────────────

function Get-OpenClawConfig {
    <#
    .SYNOPSIS
        Read and return the current OpenClaw configuration.
    #>
    [CmdletBinding()]
    param()

    if (-not (Test-Path $script:OpenClawConfigPath)) {
        Write-Warning "OpenClaw config not found at $script:OpenClawConfigPath"
        return $null
    }

    Get-Content $script:OpenClawConfigPath -Raw | ConvertFrom-Json
}

function Get-OpenClawStatus {
    <#
    .SYNOPSIS
        Check the OpenClaw gateway status and configured providers.
    #>
    [CmdletBinding()]
    param()

    $status = [ordered]@{
        StateDir     = $script:OpenClawStateDir
        ConfigPath   = $script:OpenClawConfigPath
        ConfigExists = (Test-Path $script:OpenClawConfigPath)
        GatewayPort  = $script:GatewayPort
        GatewayUp    = $false
        Providers    = @()
    }

    # Check if gateway is running
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:GatewayPort)/health" `
            -Method GET -TimeoutSec 2 -ErrorAction Stop
        $status.GatewayUp = $true
    } catch {
        $status.GatewayUp = $false
    }

    # List configured providers
    $config = Get-OpenClawConfig
    if ($config -and $config.models -and $config.models.providers) {
        $status.Providers = @($config.models.providers.PSObject.Properties.Name)
    }

    [PSCustomObject]$status
}

# ── AI Chat Functions ──────────────────────────────────────────────────

function Invoke-OpenClawChat {
    <#
    .SYNOPSIS
        Send a message through the OpenClaw gateway to a specific provider/model.

    .PARAMETER Message
        The message or prompt to send.

    .PARAMETER Provider
        AI provider to use: "anthropic", "google", "openai", etc.

    .PARAMETER Model
        Specific model ID (e.g., "claude-opus-4-6", "gemini-3-pro-preview").

    .PARAMETER SystemPrompt
        Optional system prompt to set context.

    .PARAMETER MaxTokens
        Maximum tokens in the response.

    .PARAMETER Stream
        Stream the response token by token.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [string]$Message,

        [Parameter()]
        [string]$Provider,

        [Parameter()]
        [string]$Model,

        [Parameter()]
        [string]$SystemPrompt,

        [Parameter()]
        [int]$MaxTokens = 4096,

        [switch]$Stream
    )

    # Resolve provider/model
    $resolvedModel = if ($Model) {
        if ($Provider) { "$Provider/$Model" } else { $Model }
    } elseif ($Provider) {
        switch ($Provider) {
            "anthropic" { "anthropic/claude-opus-4-6" }
            "google"    { "google/gemini-3-pro-preview" }
            default     { $Provider }
        }
    } else {
        "$($script:DefaultProvider)/$($script:DefaultModel)"
    }

    # Build the openclaw command
    $args = @("agent", "--model", $resolvedModel, "--message", $Message)

    if ($SystemPrompt) {
        $args += @("--system", $SystemPrompt)
    }

    if ($MaxTokens -gt 0) {
        $args += @("--max-tokens", $MaxTokens.ToString())
    }

    # Execute via openclaw CLI
    $openclawCmd = Get-Command "openclaw" -ErrorAction SilentlyContinue
    if (-not $openclawCmd) {
        Write-Error "OpenClaw CLI not found. Run Install-OpenClaw.ps1 first."
        return
    }

    & openclaw @args
}

function Ask-Claude {
    <#
    .SYNOPSIS
        Send a message to Anthropic Claude via OpenClaw.

    .PARAMETER Message
        The message or prompt to send to Claude.

    .PARAMETER Model
        Claude model to use (default: claude-opus-4-6).
        Options: claude-opus-4-6, claude-sonnet-4-5

    .PARAMETER SystemPrompt
        Optional system prompt.

    .EXAMPLE
        Ask-Claude "Explain quantum computing in simple terms"

    .EXAMPLE
        Ask-Claude -Message "Review this code" -Model "claude-sonnet-4-5"

    .EXAMPLE
        Get-Content script.py | Ask-Claude "Review this Python code"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [string]$Message,

        [ValidateSet("claude-opus-4-6", "claude-sonnet-4-5")]
        [string]$Model = "claude-opus-4-6",

        [string]$SystemPrompt
    )

    $params = @{
        Message  = $Message
        Provider = "anthropic"
        Model    = $Model
    }
    if ($SystemPrompt) { $params.SystemPrompt = $SystemPrompt }

    Invoke-OpenClawChat @params
}

function Ask-Gemini {
    <#
    .SYNOPSIS
        Send a message to Google Gemini via OpenClaw.

    .PARAMETER Message
        The message or prompt to send to Gemini.

    .PARAMETER Model
        Gemini model to use (default: gemini-3-pro-preview).
        Options: gemini-3-pro-preview, gemini-3-flash-preview

    .PARAMETER SystemPrompt
        Optional system prompt.

    .EXAMPLE
        Ask-Gemini "Summarize the latest trends in AI"

    .EXAMPLE
        Ask-Gemini -Message "Analyze this data" -Model "gemini-3-flash-preview"

    .EXAMPLE
        Get-Content data.csv | Ask-Gemini "Analyze this CSV data"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [string]$Message,

        [ValidateSet("gemini-3-pro-preview", "gemini-3-flash-preview")]
        [string]$Model = "gemini-3-pro-preview",

        [string]$SystemPrompt
    )

    $params = @{
        Message  = $Message
        Provider = "google"
        Model    = $Model
    }
    if ($SystemPrompt) { $params.SystemPrompt = $SystemPrompt }

    Invoke-OpenClawChat @params
}

function Ask-AI {
    <#
    .SYNOPSIS
        Send a message using the default AI provider (configurable).

    .PARAMETER Message
        The message or prompt to send.

    .PARAMETER Provider
        Override the default provider (anthropic or google).

    .EXAMPLE
        Ask-AI "What is the meaning of life?"

    .EXAMPLE
        "Translate to French: Hello world" | Ask-AI
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
        [string]$Message,

        [ValidateSet("anthropic", "google")]
        [string]$Provider
    )

    $params = @{ Message = $Message }
    if ($Provider) { $params.Provider = $Provider }

    Invoke-OpenClawChat @params
}

function Compare-AI {
    <#
    .SYNOPSIS
        Send the same prompt to both Claude and Gemini and compare responses.

    .PARAMETER Message
        The message to send to both providers.

    .PARAMETER SystemPrompt
        Optional shared system prompt.

    .EXAMPLE
        Compare-AI "What are the pros and cons of microservices?"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string]$Message,

        [string]$SystemPrompt
    )

    Write-Host "`n--- Claude (Anthropic) ---" -ForegroundColor Magenta
    $claudeParams = @{
        Message  = $Message
        Provider = "anthropic"
    }
    if ($SystemPrompt) { $claudeParams.SystemPrompt = $SystemPrompt }
    Invoke-OpenClawChat @claudeParams

    Write-Host "`n--- Gemini (Google) ---" -ForegroundColor Blue
    $geminiParams = @{
        Message  = $Message
        Provider = "google"
    }
    if ($SystemPrompt) { $geminiParams.SystemPrompt = $SystemPrompt }
    Invoke-OpenClawChat @geminiParams
}

# ── Provider Management ────────────────────────────────────────────────

function Set-DefaultProvider {
    <#
    .SYNOPSIS
        Set the default AI provider for Ask-AI.

    .PARAMETER Provider
        Provider name: "anthropic" (Claude) or "google" (Gemini).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidateSet("anthropic", "google")]
        [string]$Provider
    )

    $script:DefaultProvider = $Provider
    $script:DefaultModel = switch ($Provider) {
        "anthropic" { "claude-opus-4-6" }
        "google"    { "gemini-3-pro-preview" }
    }

    Write-Host "Default provider set to $Provider ($($script:DefaultModel))" -ForegroundColor Green
}

function Set-AIApiKey {
    <#
    .SYNOPSIS
        Set an API key for a provider in the current session.

    .PARAMETER Provider
        Provider name: "anthropic" or "google".

    .PARAMETER ApiKey
        The API key value.

    .PARAMETER Persist
        Also save to the OpenClaw config file.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [ValidateSet("anthropic", "google")]
        [string]$Provider,

        [Parameter(Mandatory, Position = 1)]
        [string]$ApiKey,

        [switch]$Persist
    )

    # Set environment variable for current session
    switch ($Provider) {
        "anthropic" { $env:ANTHROPIC_API_KEY = $ApiKey }
        "google"    { $env:GEMINI_API_KEY = $ApiKey }
    }

    Write-Host "$Provider API key set for this session" -ForegroundColor Green

    if ($Persist) {
        $config = @{}
        if (Test-Path $script:OpenClawConfigPath) {
            $config = Get-Content $script:OpenClawConfigPath -Raw | ConvertFrom-Json -AsHashtable
        }

        if (-not $config.ContainsKey("models")) { $config["models"] = @{} }
        if (-not $config["models"].ContainsKey("providers")) { $config["models"]["providers"] = @{} }
        if (-not $config["models"]["providers"].ContainsKey($Provider)) {
            $config["models"]["providers"][$Provider] = @{}
        }

        $config["models"]["providers"][$Provider]["apiKey"] = $ApiKey
        $config | ConvertTo-Json -Depth 10 | Set-Content -Path $script:OpenClawConfigPath -Encoding UTF8

        Write-Host "$Provider API key persisted to config" -ForegroundColor Green
    }
}

# ── Google Workspace Functions ─────────────────────────────────────────

function Connect-GoogleWorkspace {
    <#
    .SYNOPSIS
        Set up Google Workspace integration (Gmail hooks, Google Chat, Gemini).

    .DESCRIPTION
        Interactive setup wizard that configures:
        - Google Gemini API authentication
        - Gmail webhook integration for incoming email notifications
        - Google Chat channel (if desired)

    .PARAMETER GmailAccount
        Gmail account for webhook integration.

    .PARAMETER SkipGemini
        Skip Gemini authentication (if already configured).

    .PARAMETER SkipGmail
        Skip Gmail hook setup.
    #>
    [CmdletBinding()]
    param(
        [string]$GmailAccount,
        [switch]$SkipGemini,
        [switch]$SkipGmail
    )

    Write-Host ""
    Write-Host "  Google Workspace Integration Setup" -ForegroundColor Blue
    Write-Host "  Connecting OpenClaw to your Google services" -ForegroundColor DarkBlue
    Write-Host ""

    # Step 1: Gemini auth
    if (-not $SkipGemini) {
        Write-Host "[1/3] Authenticating with Google Gemini..." -ForegroundColor Cyan

        $hasGeminiKey = $env:GEMINI_API_KEY -or $env:GOOGLE_API_KEY
        if ($hasGeminiKey) {
            Write-Host "  Gemini API key found in environment" -ForegroundColor Green
        } else {
            Write-Host "  Choose authentication method:" -ForegroundColor Yellow
            Write-Host "    1. API Key (from Google AI Studio)"
            Write-Host "    2. OAuth (Gemini CLI flow)"
            Write-Host ""

            $choice = Read-Host "  Select [1/2]"
            switch ($choice) {
                "1" {
                    $key = Read-Host "  Enter your Gemini API key" -AsSecureString
                    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
                    $plainKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
                    Set-AIApiKey -Provider "google" -ApiKey $plainKey -Persist
                }
                "2" {
                    Write-Host "  Starting OAuth flow..." -ForegroundColor Cyan
                    & openclaw models auth google-gemini-cli
                }
                default {
                    Write-Host "  Skipping Gemini auth" -ForegroundColor Yellow
                }
            }
        }
    }

    # Step 2: Gmail hooks
    if (-not $SkipGmail) {
        Write-Host ""
        Write-Host "[2/3] Setting up Gmail integration..." -ForegroundColor Cyan

        if (-not $GmailAccount) {
            $GmailAccount = Read-Host "  Enter your Gmail address (or press Enter to skip)"
        }

        if ($GmailAccount) {
            $config = @{}
            if (Test-Path $script:OpenClawConfigPath) {
                $config = Get-Content $script:OpenClawConfigPath -Raw | ConvertFrom-Json -AsHashtable
            }

            if (-not $config.ContainsKey("hooks")) { $config["hooks"] = @{} }
            $config["hooks"]["enabled"] = $true
            $config["hooks"]["gmail"] = @{
                account            = $GmailAccount
                label              = "INBOX"
                topic              = "gog-gmail-watch"
                subscription       = "gog-gmail-watch-push"
                includeBody        = $true
                maxBytes           = 20000
                renewEveryMinutes  = 720
            }

            if (-not $config["hooks"].ContainsKey("presets")) {
                $config["hooks"]["presets"] = @()
            }
            if ("gmail" -notin $config["hooks"]["presets"]) {
                $config["hooks"]["presets"] += "gmail"
            }

            $config | ConvertTo-Json -Depth 10 | Set-Content -Path $script:OpenClawConfigPath -Encoding UTF8
            Write-Host "  Gmail hooks configured for $GmailAccount" -ForegroundColor Green
            Write-Host "  Run 'openclaw gateway' to activate webhook listener" -ForegroundColor DarkGray
        } else {
            Write-Host "  Skipping Gmail setup" -ForegroundColor Yellow
        }
    }

    # Step 3: Google Chat
    Write-Host ""
    Write-Host "[3/3] Google Chat channel..." -ForegroundColor Cyan
    Write-Host "  Google Chat integration is available as an extension." -ForegroundColor DarkGray
    Write-Host "  Enable it in your config under channels.googlechat" -ForegroundColor DarkGray
    Write-Host "  See: openclaw docs channels" -ForegroundColor DarkGray

    Write-Host ""
    Write-Host "  Google Workspace setup complete!" -ForegroundColor Green
    Write-Host "  Start the gateway to activate integrations: openclaw gateway" -ForegroundColor Cyan
    Write-Host ""
}

function Get-GmailHookStatus {
    <#
    .SYNOPSIS
        Check the status of Gmail hook integration.
    #>
    [CmdletBinding()]
    param()

    $config = Get-OpenClawConfig
    if (-not $config -or -not $config.hooks -or -not $config.hooks.gmail) {
        Write-Host "Gmail hooks not configured. Run Connect-GoogleWorkspace to set up." -ForegroundColor Yellow
        return
    }

    $gmail = $config.hooks.gmail
    [PSCustomObject]@{
        Account       = $gmail.account
        Label         = $gmail.label
        Topic         = $gmail.topic
        Subscription  = $gmail.subscription
        IncludeBody   = $gmail.includeBody
        HooksEnabled  = $config.hooks.enabled
    }
}

# ── Gateway Management ─────────────────────────────────────────────────

function Start-OpenClawGateway {
    <#
    .SYNOPSIS
        Start the OpenClaw gateway in the background.
    #>
    [CmdletBinding()]
    param(
        [switch]$Dev,
        [switch]$Foreground
    )

    $args = @("gateway")
    if ($Dev) { $args += "--dev" }

    if ($Foreground) {
        & openclaw @args
    } else {
        Write-Host "Starting OpenClaw gateway on port $($script:GatewayPort)..." -ForegroundColor Cyan
        Start-Process -FilePath "openclaw" -ArgumentList $args -WindowStyle Hidden
        Start-Sleep -Seconds 2
        $status = Get-OpenClawStatus
        if ($status.GatewayUp) {
            Write-Host "Gateway running on port $($script:GatewayPort)" -ForegroundColor Green
        } else {
            Write-Host "Gateway may still be starting. Check: openclaw logs" -ForegroundColor Yellow
        }
    }
}

function Stop-OpenClawGateway {
    <#
    .SYNOPSIS
        Stop the OpenClaw gateway.
    #>
    [CmdletBinding()]
    param()

    & openclaw system stop 2>$null
    Write-Host "Gateway stop signal sent" -ForegroundColor Green
}

# ── Aliases ────────────────────────────────────────────────────────────

New-Alias -Name "claude" -Value "Ask-Claude" -Force -Scope Global
New-Alias -Name "gemini" -Value "Ask-Gemini" -Force -Scope Global
New-Alias -Name "ai"     -Value "Ask-AI"     -Force -Scope Global
New-Alias -Name "oc"     -Value "openclaw"   -Force -Scope Global -ErrorAction SilentlyContinue

# ── Tab Completion ─────────────────────────────────────────────────────

# Register argument completers for provider and model parameters
$providerCompleter = {
    param($commandName, $parameterName, $wordToComplete, $commandAst, $fakeBoundParameters)
    @("anthropic", "google") | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)
    }
}

$claudeModelCompleter = {
    param($commandName, $parameterName, $wordToComplete, $commandAst, $fakeBoundParameters)
    @("claude-opus-4-6", "claude-sonnet-4-5") |
        Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)
    }
}

$geminiModelCompleter = {
    param($commandName, $parameterName, $wordToComplete, $commandAst, $fakeBoundParameters)
    @("gemini-3-pro-preview", "gemini-3-flash-preview") |
        Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)
    }
}

Register-ArgumentCompleter -CommandName "Invoke-OpenClawChat" -ParameterName "Provider" -ScriptBlock $providerCompleter
Register-ArgumentCompleter -CommandName "Ask-Claude"          -ParameterName "Model"    -ScriptBlock $claudeModelCompleter
Register-ArgumentCompleter -CommandName "Ask-Gemini"          -ParameterName "Model"    -ScriptBlock $geminiModelCompleter
Register-ArgumentCompleter -CommandName "Ask-AI"              -ParameterName "Provider" -ScriptBlock $providerCompleter

# ── Module Export ──────────────────────────────────────────────────────

Export-ModuleMember -Function @(
    "Get-OpenClawConfig"
    "Get-OpenClawStatus"
    "Invoke-OpenClawChat"
    "Ask-Claude"
    "Ask-Gemini"
    "Ask-AI"
    "Compare-AI"
    "Set-DefaultProvider"
    "Set-AIApiKey"
    "Connect-GoogleWorkspace"
    "Get-GmailHookStatus"
    "Start-OpenClawGateway"
    "Stop-OpenClawGateway"
) -Alias @(
    "claude"
    "gemini"
    "ai"
    "oc"
)
