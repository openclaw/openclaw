# Controlled TradingAgents installer for OpenClaw.
# It vendors TauricResearch/TradingAgents under this repo and prepares a repo-local venv.

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$VendorRoot = Join-Path $Root ".openclaw\vendors"
$TaDir = Join-Path $VendorRoot "TradingAgents"
$VenvDir = Join-Path $Root ".openclaw\venvs\tradingagents"

Write-Host "=== TradingAgents controlled install ===" -ForegroundColor Cyan
Write-Host "Repo: $Root"
Write-Host "TradingAgents: $TaDir"
Write-Host "Venv: $VenvDir"

New-Item -ItemType Directory -Force -Path $VendorRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $VenvDir -Parent) | Out-Null

if (-not (Test-Path $TaDir)) {
    Write-Host "[1/4] Cloning TauricResearch/TradingAgents..." -ForegroundColor Yellow
    git clone https://github.com/TauricResearch/TradingAgents.git $TaDir
} else {
    Write-Host "[1/4] Updating existing TradingAgents checkout..." -ForegroundColor Yellow
    Push-Location $TaDir
    git pull --ff-only
    Pop-Location
}

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) {
    $python = (Get-Command py -ErrorAction Stop).Source
}

$venvPython = Join-Path $VenvDir "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "[2/4] Creating repo-local Python venv..." -ForegroundColor Yellow
    & $python -m venv $VenvDir
} else {
    Write-Host "[2/4] Repo-local Python venv exists" -ForegroundColor Green
}

$pip = Join-Path $VenvDir "Scripts\pip.exe"
Write-Host "[3/4] Installing TradingAgents editable package..." -ForegroundColor Yellow
& $pip install -e $TaDir

Write-Host "[4/4] Running upstream readiness check..." -ForegroundColor Yellow
pnpm tradingagents:upstream:check

Write-Host ""
Write-Host "Ready. Start simulated OpenClaw bridge with:" -ForegroundColor Green
Write-Host "  pnpm tradingagents:start"
Write-Host "Start upstream bridge only after readiness is pass:"
Write-Host "  .openclaw\venvs\tradingagents\Scripts\python.exe scripts\tradingagents-bridge\server.py --provider ollama --model qwen3:14b --strict-upstream"
