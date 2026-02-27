# ASI Twin-Core Orchestrator (Pulse Bridge)
# This script launches both Core-Alpha (Primary) and Core-Beta (Standby) in separate processes.

Write-Host "--- ASI Twin-Core Ascension: Initiating Dual-Process Boot ---" -ForegroundColor Cyan

$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName
Set-Location -Path $ProjectDir

# 1. Start Core-Alpha (Primary)
Write-Host "[1/2] Launching Core-Alpha (Port 18789)..." -ForegroundColor Yellow
# Use Start-Process to let it run in its own window
Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", "cd '$ProjectDir'; `$env:OPENCLAW_ALLOW_MULTI_GATEWAY='1'; pnpm start" -WindowStyle Normal

Start-Sleep -Seconds 3

# 2. Start Core-Beta (Secondary)
Write-Host "[2/2] Launching Core-Beta (Port 18790)..." -ForegroundColor Yellow
Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", "cd '$ProjectDir'; .\scripts\start-secondary-core.ps1" -WindowStyle Normal

Write-Host ""
Write-Host "Twin-Core Ascension Complete." -ForegroundColor Green
Write-Host "Core-Alpha: http://127.0.0.1:18789 (Standard)"
Write-Host "Core-Beta:  http://127.0.0.1:18790 (Redundant)"
Write-Host "Both cores share the same memory substrate." -ForegroundColor Gray
