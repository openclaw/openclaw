#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install OpenClaw to user storage on Azure Virtual Desktop

.DESCRIPTION
    This script installs OpenClaw (ClawdBot) to the current user's storage directory.
    - No admin privileges required
    - Per-user installation
    - Automatic service setup
    - Custom version support via URL parameter

.PARAMETER OpenClawUrl
    URL to download OpenClaw tarball (defaults to latest release)

.EXAMPLE
    .\Install-OpenClaw.ps1
    Install latest OpenClaw version

.EXAMPLE
    .\Install-OpenClaw.ps1 -OpenClawUrl "https://github.com/j0904/clawdbot/releases/download/v1.0.0/openclaw-1.0.0.tgz"
    Install specific version

.NOTES
    Designed for Azure Virtual Desktop environments
    Stores data in C:\UserStorage\<username>\OpenClaw
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$OpenClawUrl = "https://github.com/j0904/clawdbot/releases/download/latest/openclaw-2026.2.9.tgz"
)

$ErrorActionPreference = 'Continue'
$username = $env:USERNAME
$userStoragePath = "C:\UserStorage\$username"
$openclawInstallPath = Join-Path $userStoragePath "OpenClaw"
$openclawBinPath = Join-Path $openclawInstallPath "bin"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "OpenClaw Installation for $username" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ==============================================================================
# Verify Node.js is available
# ==============================================================================
Write-Host "Checking prerequisites..." -ForegroundColor Yellow
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Host ""
    Write-Host "ERROR: Node.js is not installed on this system." -ForegroundColor Red
    Write-Host "Please contact your system administrator." -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Node.js found: $($nodeCommand.Source)" -ForegroundColor Green
Write-Host "Node version: " -NoNewline
& node --version
Write-Host ""

# ==============================================================================
# Create user directories
# ==============================================================================
Write-Host "Creating user storage directories..." -ForegroundColor Yellow
New-Item -Path $userStoragePath -ItemType Directory -Force | Out-Null
New-Item -Path $openclawInstallPath -ItemType Directory -Force | Out-Null
New-Item -Path $openclawBinPath -ItemType Directory -Force | Out-Null

# ==============================================================================
# Check if OpenClaw is already installed
# ==============================================================================
$existingOpenClaw = Get-ChildItem $openclawBinPath -Filter "*.js" -ErrorAction SilentlyContinue
if ($existingOpenClaw) {
    Write-Host ""
    Write-Host "OpenClaw is already installed at: $openclawInstallPath" -ForegroundColor Yellow
    $response = Read-Host "Do you want to reinstall/update? (Y/N)"
    if ($response -notmatch "^[Yy]") {
        Write-Host "Installation cancelled. Using existing OpenClaw." -ForegroundColor Cyan
        Write-Host ""
        Read-Host "Press Enter to close"
        exit 0
    }
    Write-Host "Removing existing installation..." -ForegroundColor Yellow
    Remove-Item -Path "$openclawInstallPath\*" -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -Path $openclawBinPath -ItemType Directory -Force | Out-Null
}

# ==============================================================================
# Download OpenClaw
# ==============================================================================
Write-Host ""
Write-Host "Downloading OpenClaw from:" -ForegroundColor Yellow
Write-Host "  $OpenClawUrl" -ForegroundColor Cyan
$tgzPath = Join-Path $env:TEMP "openclaw-$username.tgz"
$extractPath = Join-Path $env:TEMP "openclaw-extract-$username"

try {
    Invoke-WebRequest -Uri $OpenClawUrl -OutFile $tgzPath -UseBasicParsing -ErrorAction Stop
    Write-Host "Download complete" -ForegroundColor Green

    # Extract tarball
    Write-Host "Extracting OpenClaw..." -ForegroundColor Yellow
    New-Item -Path $extractPath -ItemType Directory -Force | Out-Null
    tar -xzf $tgzPath -C $extractPath

    # Move files to user installation directory
    Write-Host "Installing to user storage..." -ForegroundColor Yellow
    if (Test-Path "$extractPath\package") {
        Copy-Item -Path "$extractPath\package\*" -Destination $openclawBinPath -Recurse -Force
    } else {
        Copy-Item -Path "$extractPath\*" -Destination $openclawBinPath -Recurse -Force
    }

    # Clean up temp files
    Remove-Item -Path $tgzPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $extractPath -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "Extraction complete" -ForegroundColor Green

    # Install npm dependencies
    if (Test-Path "$openclawBinPath\package.json") {
        Write-Host "Installing dependencies (this may take several minutes)..." -ForegroundColor Yellow
        Push-Location $openclawBinPath
        npm install --production 2>&1 | Out-Null
        Pop-Location
        Write-Host "Dependencies installed" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "OpenClaw installed successfully to: $openclawInstallPath" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "Error installing OpenClaw: $_" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# ==============================================================================
# Configure user environment
# ==============================================================================
Write-Host ""
Write-Host "Configuring per-user OpenClaw environment..." -ForegroundColor Yellow

$openclawStatePath = Join-Path $openclawInstallPath "state"
$openclawConfigPath = Join-Path $openclawInstallPath "config.json"
$openclawLogsPath = Join-Path $openclawInstallPath "logs"

[System.Environment]::SetEnvironmentVariable("OPENCLAW_HOME", $openclawInstallPath, "User")
[System.Environment]::SetEnvironmentVariable("OPENCLAW_STATE_DIR", $openclawStatePath, "User")
[System.Environment]::SetEnvironmentVariable("OPENCLAW_CONFIG_PATH", $openclawConfigPath, "User")

$env:OPENCLAW_HOME = $openclawInstallPath
$env:OPENCLAW_STATE_DIR = $openclawStatePath
$env:OPENCLAW_CONFIG_PATH = $openclawConfigPath

New-Item -Path $openclawStatePath -ItemType Directory -Force | Out-Null
New-Item -Path $openclawLogsPath -ItemType Directory -Force | Out-Null

# Add OpenClaw bin to user PATH
$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$openclawBinPath*") {
    [System.Environment]::SetEnvironmentVariable("Path", "$userPath;$openclawBinPath", "User")
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Host "Added OpenClaw to user PATH" -ForegroundColor Green
}

Write-Host "Environment configured:" -ForegroundColor Green
Write-Host "  OPENCLAW_HOME: $env:OPENCLAW_HOME" -ForegroundColor Cyan
Write-Host "  OPENCLAW_STATE_DIR: $env:OPENCLAW_STATE_DIR" -ForegroundColor Cyan
Write-Host "  OpenClaw binaries: $openclawBinPath" -ForegroundColor Cyan

# ==============================================================================
# Find the main OpenClaw executable
# ==============================================================================
$openclawExe = Get-ChildItem $openclawBinPath -Filter "index.js" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $openclawExe) {
    $openclawExe = Get-ChildItem $openclawBinPath -Filter "openclaw.js" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $openclawExe) {
    $openclawExe = Get-ChildItem $openclawBinPath -Filter "*.js" -ErrorAction SilentlyContinue | Select-Object -First 1
}

if (-not $openclawExe) {
    Write-Host "Warning: Could not find OpenClaw main executable" -ForegroundColor Yellow
    $openclawExePath = Join-Path $openclawBinPath "index.js"
} else {
    $openclawExePath = $openclawExe.FullName
}

# ==============================================================================
# Create service wrapper
# ==============================================================================
$serviceWrapper = @"
@echo off
cd /d "$openclawBinPath"
set OPENCLAW_HOME=$openclawInstallPath
set OPENCLAW_STATE_DIR=$openclawStatePath
set OPENCLAW_CONFIG_PATH=$openclawConfigPath
node "$openclawExePath" start-gateway --daemon >> "$openclawLogsPath\service.log" 2>&1
"@

$wrapperPath = Join-Path $openclawInstallPath "start-service.bat"
$serviceWrapper | Out-File -FilePath $wrapperPath -Encoding ASCII

# ==============================================================================
# Create scheduled task
# ==============================================================================
Write-Host ""
Write-Host "Creating persistent service (runs at login)..." -ForegroundColor Yellow

$taskName = "OpenClaw-$username"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$wrapperPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $username
$principal = New-ScheduledTaskPrincipal -UserId $username -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Days 365) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "Scheduled task created successfully" -ForegroundColor Green

    # Start service
    Write-Host "Starting OpenClaw service..." -ForegroundColor Yellow
    Start-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 3
    Write-Host "OpenClaw service started!" -ForegroundColor Green
} catch {
    Write-Host "Warning: Could not create scheduled task: $_" -ForegroundColor Yellow
    Write-Host "You can start OpenClaw manually using: $wrapperPath" -ForegroundColor Cyan
}

# ==============================================================================
# Installation Complete
# ==============================================================================
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Installation Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Your OpenClaw installation:" -ForegroundColor Cyan
Write-Host "  Location: $openclawInstallPath" -ForegroundColor White
Write-Host "  Binaries: $openclawBinPath" -ForegroundColor White
Write-Host "  Logs: $openclawLogsPath" -ForegroundColor White
Write-Host ""
Write-Host "The service will automatically start when you log in." -ForegroundColor Green
Write-Host ""
Write-Host "To install a different version, run this script again with:" -ForegroundColor Yellow
Write-Host "  powershell -File Install-OpenClaw.ps1 -OpenClawUrl <your-url>" -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter to close this window"
