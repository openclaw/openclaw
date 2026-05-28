$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Port = 8390

function Invoke-JsonCommand {
    param([string]$FilePath, [string[]]$Arguments)
    $output = & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $FilePath $($Arguments -join ' ')"
    }
    $text = ($output | Out-String).Trim()
    $start = $text.IndexOf("{")
    $end = $text.LastIndexOf("}")
    if ($start -lt 0 -or $end -lt $start) {
        throw "Command did not return JSON: $FilePath"
    }
    return $text.Substring($start, $end - $start + 1) | ConvertFrom-Json
}

function Find-BridgeProcess {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if (-not $conn) { return $null }
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
        if ($proc.CommandLine -like "*tradingagents-bridge*server.py*") {
            return $proc
        }
    } catch {
        return $null
    }
    return $null
}

function Wait-BridgeHealth {
    param([int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    throw "Bridge health timeout after $TimeoutSec seconds"
}

Write-Host "=== TradingAgents x OpenClaw (paper-only) ===" -ForegroundColor Cyan
Set-Location $Root

$systemPython = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $systemPython) {
    $systemPython = (Get-Command py -ErrorAction Stop).Source
}

$upstream = Invoke-JsonCommand -FilePath "node" -Arguments @("scripts/check-openclaw-tradingagents-upstream.mjs", "--allow-blocked")
$useUpstream = [bool]$upstream.canStartUpstreamBridge

$python = $systemPython
$pythonPrefixArgs = @()
$provider = "simulated"
$model = "gpt-5.4-mini"
$strictArgs = @()
if ($useUpstream) {
    $python = [string]$upstream.import.active.command
    $pythonPrefixArgs = @($upstream.import.active.args)
    $provider = [string]$upstream.provider
    $model = [string]$upstream.model
    $strictArgs = @("--strict-upstream")
    Write-Host "[mode] upstream TradingAgents ready: provider=$provider model=$model" -ForegroundColor Green
} else {
    Write-Host "[mode] simulated bridge: $($upstream.remainingBlockers -join '; ')" -ForegroundColor Yellow
}

$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
} catch {
    $health = $null
}

if ($health -and $useUpstream -and $health.provider -eq "simulated") {
    $proc = Find-BridgeProcess
    if ($proc) {
        Write-Host "[1/4] Restarting bridge to upstream mode..." -ForegroundColor Yellow
        Stop-Process -Id $proc.ProcessId -Force
        Start-Sleep -Seconds 1
        $health = $null
    }
}

if ($health) {
    Write-Host "[1/4] Bridge already running: status=$($health.status) provider=$($health.provider)" -ForegroundColor Green
} else {
    Write-Host "[1/4] Starting bridge on 127.0.0.1:$Port provider=$provider..." -ForegroundColor Yellow
    $serverArgs = @("scripts/tradingagents-bridge/server.py", "--provider", $provider, "--model", $model, "--port", "$Port") + $strictArgs
    Start-Process -FilePath $python `
        -ArgumentList ($pythonPrefixArgs + $serverArgs) `
        -WorkingDirectory $Root `
        -WindowStyle Hidden
    $health = Wait-BridgeHealth -TimeoutSec 30
}

Write-Host "[2/4] Bridge health..." -ForegroundColor Yellow
$health | ConvertTo-Json -Depth 8

Write-Host "[3/4] Bridge self-test..." -ForegroundColor Yellow
$selfTestArgs = @(
    "scripts/tradingagents-bridge/server.py",
    "--self-test",
    "--json",
    "--provider",
    "simulated",
    "--model",
    "gpt-5.4-mini",
    "--no-write-state"
)
& $python @($pythonPrefixArgs + $selfTestArgs)

Write-Host "[4/4] Strategy engine readiness..." -ForegroundColor Yellow
pnpm engine:run:json
