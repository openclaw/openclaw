param(
    [int]$GatewayPort = 18789,
    [string]$GatewayBind = "loopback",
    [string]$GatewayMode = "online",
    [string]$Profile = "desktop-stack",
    [switch]$SkipVoice,
    [switch]$SkipNgrok,
    [switch]$SkipGateway,
    [switch]$SkipTui,
    [switch]$SkipBrowser,
    [switch]$SpeakOnReady
)

$ErrorActionPreference = "Stop"

$ProjectDir = (Get-Item $PSScriptRoot).Parent.Parent.FullName
. "$PSScriptRoot\env-tools.ps1"

$envFile = Ensure-ProjectEnvFile -ProjectDir $ProjectDir
$desktopStateDir = Join-Path $ProjectDir ".openclaw-desktop"
$desktopConfigPath = Join-Path $desktopStateDir "openclaw.json"
New-Item -ItemType Directory -Path $desktopStateDir -Force | Out-Null

function Write-Step {
    param(
        [string]$Message,
        [string]$Color = "Cyan"
    )

    Write-Host $Message -ForegroundColor $Color
}

function Resolve-LaunchCommand {
    $pnpmCmd = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
    if ($pnpmCmd) {
        return @{
            FilePath = $pnpmCmd.Source
            Prefix   = @()
            Label    = "pnpm"
        }
    }

    $corepackCmd = Get-Command "corepack.cmd" -ErrorAction SilentlyContinue
    if ($corepackCmd) {
        return @{
            FilePath = $corepackCmd.Source
            Prefix   = @("pnpm")
            Label    = "corepack pnpm"
        }
    }

    throw "Neither pnpm.cmd nor corepack.cmd was found in PATH."
}

function Test-PortListening {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $listener)
}

function Wait-HttpReady {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200) {
                return $true
            }
        } catch {
            Start-Sleep -Milliseconds 800
        }
    }

    return $false
}

function Wait-PortListening {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening -Port $Port) {
            return $true
        }
        Start-Sleep -Milliseconds 800
    }

    return $false
}

function Start-StackProcess {
    param(
        [string]$Title,
        [string[]]$CommandParts,
        [string]$WorkingDirectory,
        [hashtable]$EnvironmentOverrides = @{},
        [ValidateSet("Normal", "Minimized", "Hidden")]
        [string]$WindowStyle = "Normal"
    )

    $quotedCommandParts = $CommandParts | ForEach-Object {
        '"' + ($_ -replace '"', '\"') + '"'
    }
    $commandLine = "& " + ($quotedCommandParts -join " ")

    $envAssignments = @()
    foreach ($key in ($EnvironmentOverrides.Keys | Sort-Object)) {
        $escapedValue = [string]$EnvironmentOverrides[$key]
        $escapedValue = $escapedValue.Replace("'", "''")
        $envAssignments += "`$env:$key='$escapedValue'"
    }

    $scriptLines = @(
        "`$host.UI.RawUI.WindowTitle = '$($Title.Replace("'", "''"))'",
        "Set-Location -Path '$($WorkingDirectory.Replace("'", "''"))'"
    )
    if ($envAssignments.Count -gt 0) {
        $scriptLines += ($envAssignments -join "; ")
    }
    $scriptLines += $commandLine

    $command = $scriptLines -join "; "

    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        $command
    ) -WorkingDirectory $WorkingDirectory -WindowStyle $WindowStyle | Out-Null
}

$launcher = Resolve-LaunchCommand
$token = Get-OrCreateGatewayToken -EnvFile $envFile
$localGatewayUrl = "http://127.0.0.1:$GatewayPort"
$wsGatewayUrl = "ws://127.0.0.1:$GatewayPort"

Set-EnvValues -EnvFile $envFile -Values @{
    OPENCLAW_GATEWAY_PORT      = $GatewayPort
    CLAWDBOT_GATEWAY_PORT      = $GatewayPort
    OPENCLAW_GATEWAY_BIND      = $GatewayBind
    CLAWDBOT_GATEWAY_BIND      = $GatewayBind
    OPENCLAW_GATEWAY_MODE      = $GatewayMode
    CLAWDBOT_GATEWAY_MODE      = $GatewayMode
    OPENCLAW_GATEWAY_TOKEN     = $token
    OPENCLAW_PROFILE           = $Profile
    OPENCLAW_STATE_DIR         = $desktopStateDir
    OPENCLAW_CONFIG_PATH       = $desktopConfigPath
    OPENCLAW_LOCAL_URL         = $localGatewayUrl
    OPENCLAW_BROWSER_URL       = $localGatewayUrl
    OPENCLAW_DESKTOP_LAUNCHER  = "scripts/launchers/launch-desktop-stack.ps1"
}

Write-Host ""
Write-Step "========================================"
Write-Step " OpenClaw Desktop Stack Launcher"
Write-Step "========================================"
Write-Host "Project : $ProjectDir"
Write-Host "Gateway : $localGatewayUrl"
Write-Host "Profile : $Profile"
Write-Host "State   : $desktopStateDir"
Write-Host "Runner  : $($launcher.Label)"
Write-Host ""

if (-not $SkipVoice) {
    Write-Step "[1/5] Starting VOICEVOX..."
    $voiceArgs = @(
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        (Join-Path $PSScriptRoot "start-voicevox.ps1")
    )
    if ($SpeakOnReady) {
        $voiceArgs += "-SpeakOnReady"
    }
    & powershell.exe @voiceArgs
}

if (-not $SkipNgrok) {
    Write-Step "[2/5] Syncing ngrok tunnel..."
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        (Join-Path $PSScriptRoot "start_ngrok.ps1"),
        "-Port",
        [string]$GatewayPort
    ) -WorkingDirectory $ProjectDir -WindowStyle Minimized | Out-Null
}

$processEnv = @{
    OPENCLAW_GATEWAY_PORT  = [string]$GatewayPort
    CLAWDBOT_GATEWAY_PORT  = [string]$GatewayPort
    OPENCLAW_GATEWAY_BIND  = $GatewayBind
    CLAWDBOT_GATEWAY_BIND  = $GatewayBind
    OPENCLAW_GATEWAY_MODE  = $GatewayMode
    CLAWDBOT_GATEWAY_MODE  = $GatewayMode
    OPENCLAW_GATEWAY_TOKEN = $token
    OPENCLAW_PROFILE       = $Profile
    OPENCLAW_STATE_DIR     = $desktopStateDir
    OPENCLAW_CONFIG_PATH   = $desktopConfigPath
}
foreach ($entry in $processEnv.GetEnumerator()) {
    Set-Item -Path ("Env:" + $entry.Key) -Value ([string]$entry.Value)
}

if (-not $SkipGateway) {
    Write-Step "[3/5] Ensuring gateway is running..."
    if (Test-PortListening -Port $GatewayPort) {
        Write-Host "Gateway already listening on $GatewayPort. Restarting to sync auth token." -ForegroundColor Yellow
    }
    Start-StackProcess -Title "OpenClaw Gateway" -WorkingDirectory $ProjectDir -WindowStyle "Minimized" -EnvironmentOverrides $processEnv -CommandParts (@($launcher.FilePath) + $launcher.Prefix + @(
        "openclaw",
        "--profile",
        $Profile,
        "gateway",
        "run",
        "--allow-unconfigured",
        "--force",
        "--bind",
        $GatewayBind,
        "--port",
        [string]$GatewayPort,
        "--token",
        $token
    ))
    if (-not (Wait-PortListening -Port $GatewayPort -TimeoutSeconds 75)) {
        throw "Gateway did not begin listening on port $GatewayPort"
    }
    Start-Sleep -Seconds 2
}

if (-not $SkipTui) {
    Write-Step "[4/5] Launching TUI..."
    Start-StackProcess -Title "OpenClaw TUI" -WorkingDirectory $ProjectDir -EnvironmentOverrides $processEnv -CommandParts (@($launcher.FilePath) + $launcher.Prefix + @(
        "openclaw",
        "--profile",
        $Profile,
        "tui",
        "--url",
        $wsGatewayUrl,
        "--token",
        $token
    ))
}

if (-not $SkipBrowser) {
    Write-Step "[5/5] Opening browser..."
    $browserUrl = "$localGatewayUrl/#token=$token"
    Start-Process $browserUrl | Out-Null
    Set-EnvValues -EnvFile $envFile -Values @{
        OPENCLAW_BROWSER_URL = $browserUrl
    }
}

Write-Host ""
Write-Step "Desktop stack is ready." "Green"
Write-Host "Gateway URL : $localGatewayUrl"
Write-Host "Token       : $token"
Write-Host "Env file    : $envFile"
