# OpenClaw fork — install / upgrade from source (lxf-lxf/openclaw)
# Fresh install:
#   powershell -ExecutionPolicy Bypass -File scripts/fork-upgrade.ps1
# Upgrade existing checkout:
#   powershell -ExecutionPolicy Bypass -File scripts/fork-upgrade.ps1 -InstallDir C:\Users\you\Projects\openclaw
# One-liner (after clone or from raw URL):
#   irm https://raw.githubusercontent.com/lxf-lxf/openclaw/main/scripts/fork-upgrade.ps1 | iex

param(
    [string]$RepoUrl = "https://github.com/lxf-lxf/openclaw.git",
    [string]$Branch = "main",
    [string]$InstallDir = "",
    [ValidateSet("npm", "pnpm", "auto")]
    [string]$PackageManager = "auto",
    [switch]$SkipPull,
    [switch]$NoLink,
    [switch]$NoUiBuild,
    [switch]$NoGatewayCmd,
    [switch]$RestartGateway,
    [int]$GatewayPort = 18789
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host ">> $Message" -ForegroundColor Cyan
}

function Assert-NodeVersion {
    $versionText = (node -p "process.versions.node") 2>$null
    if (-not $versionText) {
        throw "Node.js not found. Install Node 22.19+ from https://nodejs.org/"
    }
    $parts = $versionText.Split(".")
    $major = [int]$parts[0]
    $minor = if ($parts.Length -gt 1) { [int]$parts[1] } else { 0 }
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19)) {
        throw "Node.js $versionText is too old. OpenClaw requires 22.19+."
    }
    Write-Host "[OK] Node $versionText" -ForegroundColor Green
}

function Resolve-InstallDir {
    if (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
        if (Test-Path -LiteralPath $InstallDir) {
            return (Resolve-Path -LiteralPath $InstallDir).Path
        }
        return $InstallDir
    }
    $projects = Join-Path $env:USERPROFILE "Projects\openclaw"
    if (Test-Path (Join-Path $env:USERPROFILE "Projects")) {
        return $projects
    }
    return (Join-Path $env:USERPROFILE "openclaw")
}

function Resolve-PackageManager([string]$Root) {
    if ($PackageManager -ne "auto") {
        return $PackageManager
    }
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        if (Test-Path (Join-Path $Root "pnpm-lock.yaml")) {
            return "pnpm"
        }
    }
    return "npm"
}

function Invoke-Package([string]$Pm, [string]$Root, [string[]]$Args) {
    Push-Location $Root
    try {
        if ($Pm -eq "pnpm") {
            & pnpm @Args
        } else {
            & npm @Args
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $Pm $($Args -join ' ') (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
}

function Stop-GatewayOnPort([int]$Port) {
    Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
        if ($cmd -match "openclaw\.mjs gateway" -and $cmd -match "--port\s+$Port") {
            Write-Host "Stopping gateway PID $($_.Id)" -ForegroundColor Yellow
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-GatewayCmd([string]$Root, [int]$Port) {
    $stateDir = Join-Path $env:USERPROFILE ".openclaw"
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $cmdPath = Join-Path $stateDir "gateway.cmd"
    $openclawMjs = Join-Path $Root "openclaw.mjs"
    $node = (Get-Command node).Source
    $versionLine = try {
        Push-Location $Root
        $v = (node openclaw.mjs --version 2>$null).Trim()
        Pop-Location
        if ($v) { $v } else { "fork" }
    } catch {
        "fork"
    }
    @"
@echo off
rem OpenClaw Gateway ($versionLine) — fork-upgrade.ps1
set "OPENCLAW_GATEWAY_PORT=$Port"
set "OPENCLAW_SERVICE_VERSION=$versionLine-fork"
"$node" "$openclawMjs" gateway --port $Port
"@ | Set-Content -Path $cmdPath -Encoding ASCII
    Write-Host "[OK] Wrote $cmdPath" -ForegroundColor Green
}

function Start-Gateway([string]$Root, [int]$Port) {
    $node = (Get-Command node).Source
    $openclawMjs = Join-Path $Root "openclaw.mjs"
    Start-Process -FilePath $node -ArgumentList "`"$openclawMjs`"", "gateway", "--port", "$Port" `
        -WorkingDirectory $Root -WindowStyle Hidden
    Start-Sleep -Seconds 6
    try {
        $code = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 8).StatusCode
        Write-Host "[OK] Gateway http://127.0.0.1:$Port/ -> $code" -ForegroundColor Green
    } catch {
        Write-Host "[WARN] Gateway started but HTTP check failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  OpenClaw fork install / upgrade" -ForegroundColor Cyan
Write-Host "  Repo: $RepoUrl ($Branch)" -ForegroundColor DarkGray
Write-Host ""

Assert-NodeVersion
$dir = Resolve-InstallDir
Write-Step "Target directory: $dir"

if (Test-Path (Join-Path $dir ".git")) {
    if (-not $SkipPull) {
        Write-Step "git pull"
        Push-Location $dir
        git fetch origin $Branch 2>&1 | Write-Host
        git checkout $Branch 2>&1 | Write-Host
        git pull --ff-only origin $Branch 2>&1 | Write-Host
        Pop-Location
    }
} elseif (Test-Path $dir) {
    throw "Directory exists but is not a git repo: $dir"
} else {
    Write-Step "git clone"
    New-Item -ItemType Directory -Force -Path (Split-Path $dir -Parent) | Out-Null
    git clone --branch $Branch $RepoUrl $dir
}

$pm = Resolve-PackageManager $dir
Write-Step "$pm install"
Invoke-Package $pm $dir @("install")

Write-Step "$pm run build"
Invoke-Package $pm $dir @("run", "build")

if (-not $NoUiBuild) {
    Write-Step "$pm run ui:build"
    Invoke-Package $pm $dir @("run", "ui:build")
}

if (-not $NoLink) {
    Write-Step "npm link (global openclaw -> this checkout)"
    Push-Location $dir
    npm link 2>&1 | Write-Host
    Pop-Location
}

Push-Location $dir
$ver = (node openclaw.mjs --version 2>&1).Trim()
Pop-Location
Write-Host ""
Write-Host "[OK] Installed: $ver" -ForegroundColor Green
Write-Host "     Path: $dir" -ForegroundColor DarkGray

if (-not $NoGatewayCmd) {
    Write-Step "Update %USERPROFILE%\.openclaw\gateway.cmd"
    Write-GatewayCmd $dir $GatewayPort
}

if ($RestartGateway) {
    Write-Step "Restart gateway on port $GatewayPort"
    Stop-GatewayOnPort $GatewayPort
    Start-Sleep -Seconds 2
    Start-Gateway $dir $GatewayPort
}

Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  openclaw config validate"
Write-Host "  openclaw gateway --port $GatewayPort"
Write-Host "  Browser: http://127.0.0.1:$GatewayPort/ (Ctrl+F5 after upgrades)"
Write-Host "  Cron ACP: docs/automation/cron-acp-quickstart.md"
Write-Host ""
