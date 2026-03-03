# OpenClaw Launcher with Browser
# Starts server, starts Ngrok, syncs URL, and opens browser when ready.

$ErrorActionPreference = "Stop"
$ProjectDir = (Get-Item $PSScriptRoot).Parent.Parent.FullName

# --- Load configuration from .env if present ---
$EnvFile = Join-Path $ProjectDir ".env"
$GatewayPort = 18789

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^([^#=]+)=(.*)$' } | ForEach-Object {
        $key = $Matches[1].Trim()
        $value = $Matches[2].Trim()
        if ($key -eq "OPENCLAW_GATEWAY_PORT") {
            $GatewayPort = [int]$value
        }
    }
}

$BrowserUrl = "http://127.0.0.1:$GatewayPort"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " OpenClaw Launcher (Hakua)" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "Project: $ProjectDir"
Write-Host "URL    : $BrowserUrl"
Write-Host ""

# --- Webhook Integration: Start Ngrok ---
$StartNgrokScript = Join-Path $ProjectDir "scripts\launchers\start_ngrok.ps1"
if (Test-Path $StartNgrokScript) {
    Write-Host "[0/3] Starting Ngrok..." -ForegroundColor Yellow
    & powershell.exe -ExecutionPolicy Bypass -File $StartNgrokScript -Port $GatewayPort
    
    # Sync Ngrok URL to .env
    $SyncScript = Join-Path $ProjectDir "scripts\sync-ngrok-url.ps1"
    if (Test-Path $SyncScript) {
        & powershell.exe -ExecutionPolicy Bypass -File $SyncScript
    }
    Write-Host ""
}

# --- Start OpenClaw Gateway as a background job ---
Write-Host "[1/3] Starting OpenClaw Server..." -ForegroundColor Yellow
$env:OPENCLAW_GATEWAY_PORT = $GatewayPort

$serverJob = Start-Job -ScriptBlock {
    param($dir, $port)
    Set-Location -Path $dir
    $env:OPENCLAW_GATEWAY_PORT = $port
    # Use built binary if available
    if (Test-Path (Join-Path $dir "dist\entry.js")) {
        node .\dist\entry.js gateway
    }
    else {
        pnpm start
    }
} -ArgumentList $ProjectDir, $GatewayPort

# --- Wait for server to be ready (max 60s) ---
Write-Host "[2/3] Waiting for server..." -ForegroundColor Yellow
$maxWait = 60
$waited = 0
$interval = 2
$isReady = $false

while ($waited -lt $maxWait) {
    Start-Sleep -Seconds $interval
    $waited += $interval
    try {
        $resp = Invoke-WebRequest -Uri $BrowserUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -ge 200) {
            $isReady = $true
            break
        }
    }
    catch {
        # Not ready yet
    }
    Write-Host "  ... $waited seconds passed (max ${maxWait}s)" -ForegroundColor DarkGray
}

# --- Open Browser ---
if ($isReady) {
    # Extract auth token to prevent rate-limit lockouts in the browser UI
    $Token = ""
    if ($env:OPENCLAW_GATEWAY_TOKEN) {
        $Token = $env:OPENCLAW_GATEWAY_TOKEN
    } else {
        $ConfigPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"
        if (Test-Path $ConfigPath) {
            try {
                $ConfigRaw = Get-Content $ConfigPath -Raw
                $Config = ConvertFrom-Json $ConfigRaw
                if ($Config.gateway.auth.mode -eq "token" -and $Config.gateway.auth.token) {
                    $Token = $Config.gateway.auth.token
                }
            } catch {}
        }
    }

    $FinalUrl = $BrowserUrl
    if ($Token) {
        $FinalUrl = "$BrowserUrl/?token=$Token"
    }

    Write-Host "[3/3] Launching browser: $FinalUrl" -ForegroundColor Green
    Start-Process $FinalUrl
}
else {
    Write-Host "[!] Server timed out." -ForegroundColor Red
    Write-Host "    Open manually: $BrowserUrl" -ForegroundColor Yellow
    Start-Process $BrowserUrl
}

# --- Display server logs ---
Write-Host ""
Write-Host "Server Logs (Ctrl+C to stop):" -ForegroundColor Cyan
Write-Host "-------------------------------------------------" -ForegroundColor DarkGray

try {
    while ($true) {
        $output = Receive-Job -Job $serverJob
        if ($output) { Write-Host $output }
        if ($serverJob.State -ne "Running") {
            Write-Host "[!] Server stopped unexpectedly." -ForegroundColor Red
            $errors = Receive-Job -Job $serverJob -ErrorAction SilentlyContinue
            if ($errors) { Write-Host $errors -ForegroundColor Red }
            break
        }
        Start-Sleep -Milliseconds 500
    }
}
finally {
    Stop-Job -Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job -Job $serverJob -ErrorAction SilentlyContinue
    Write-Host "Server shutdown." -ForegroundColor Gray
}
