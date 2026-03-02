# OpenClaw Gateway Restart Script (Windows)
# Kills gateway, restarts, waits for connection, auto-approves pairing repair

Write-Host "Stopping gateway..." -ForegroundColor Yellow
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

Write-Host "Starting gateway..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit","-Command","cd D:\openclaw; `$env:OPENCLAW_NO_RESPAWN='1'; pnpm run openclaw gateway" -WindowStyle Minimized

Write-Host "Waiting for gateway to come up..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $result = & pnpm run openclaw -- devices list 2>&1 | Out-String
    if ($result -match "Pending") {
        $ready = $true
        break
    }
    if ($result -match "Paired" -and $result -notmatch "Pending") {
        Write-Host "Gateway up — no pairing repair needed!" -ForegroundColor Green
        exit 0
    }
}

if (-not $ready) {
    Write-Host "Gateway not ready after 60s — check manually" -ForegroundColor Red
    exit 1
}

# Auto-approve pending repair
Write-Host "Approving pairing repair..." -ForegroundColor Yellow
$pending = & pnpm run openclaw -- devices list 2>&1 | Out-String
if ($pending -match "([a-f0-9\-]{36})") {
    $requestId = $matches[1]
    & pnpm run openclaw -- devices approve $requestId 2>&1
    Write-Host "Pairing approved: $requestId" -ForegroundColor Green
} else {
    Write-Host "No pending request found" -ForegroundColor Yellow
}

Write-Host "Gateway restart complete!" -ForegroundColor Green
