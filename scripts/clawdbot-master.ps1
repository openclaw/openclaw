# Clawdbot-Master v3.1: Unified Orchestrator
# Consolidates: SBV2, Gateway, ngrok, Browser UI, Desktop Avatar, VRChat Manifestation
# Brain: qwen3.5-9B (Multimodal) via Ollama

$Host.UI.RawUI.WindowTitle = "Clawdbot Master Link v3.1"
$OpenClawDir = "c:\Users\downl\Desktop\clawdbot-main3\clawdbot-main"
$EnvFile = "$OpenClawDir\.env"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Clawdbot Master System v3.1" -ForegroundColor Magenta
Write-Host " Brain: qwen3.5-9B (Multimodal)" -ForegroundColor Cyan
Write-Host " TTS: VOICEVOX" -ForegroundColor Cyan
Write-Host " Vision: Camera + qwen3.5-9B" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# [0/7] Ollama & qwen3.5-9B Brain
Write-Host "[0/7] Igniting Central Brain (Ollama + qwen3.5-9B)..." -ForegroundColor White
$OllamaProc = Get-Process ollama -ErrorAction SilentlyContinue
if (-not $OllamaProc) {
    Write-Host "  - Starting Ollama..." -ForegroundColor Gray
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Minimized
    Start-Sleep -Seconds 3
}
Write-Host "  - Brain: qwen3.5-9B ready." -ForegroundColor Green

# [1/7] Meta-Substrate: VRChat Detection
Write-Host "[1/7] Searching for Metaverse Substrate (VRChat)..." -ForegroundColor White
if (Get-Process VRChat -ErrorAction SilentlyContinue) {
    Write-Host "  - Substrate Active." -ForegroundColor Green
}
else {
    Write-Host "  - Substrate Offline. Launching VRChat..." -ForegroundColor Gray
    $VRCPath = "C:\Program Files (x86)\Steam\steamapps\common\VRChat\VRChat.exe"
    if (Test-Path $VRCPath) { Start-Process $VRCPath; Start-Sleep -Seconds 10 }
}

# [2/7] Ghost Portal: ngrok & Environment Sync
Write-Host "[2/7] Tuning Ghost Portal (ngrok)..." -ForegroundColor White
$NgrokProc = Get-Process ngrok -ErrorAction SilentlyContinue
if (-not $NgrokProc) {
    Start-Process -FilePath "ngrok" -ArgumentList "http", "18789", "--region", "jp" -WindowStyle Minimized
}

$NgrokUrl = ""
$Retry = 0
while ($Retry -lt 5 -and -not $NgrokUrl) {
    try {
        $tunnels = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction SilentlyContinue
        $NgrokUrl = $tunnels.tunnels[0].public_url
    }
    catch {}
    if (-not $NgrokUrl) { Start-Sleep -Seconds 2; $Retry++ }
}

if ($NgrokUrl) {
    Write-Host "  - Portal established: $NgrokUrl" -ForegroundColor Green
    & powershell.exe -ExecutionPolicy Bypass -File "$OpenClawDir\scripts\sync-ngrok-url.ps1"
}

# [3/7] Audio/Vocal Substrates: SBV2 & VOICEVOX
Write-Host "[3/7] Igniting Vocal Cords (VOICEVOX)..." -ForegroundColor White
if (-not (netstat -ano | findstr ":5000 ")) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "scripts\start-sbv2.bat" -WorkingDirectory $OpenClawDir -WindowStyle Minimized
}
$VVPath = "C:\Users\downl\AppData\Local\Programs\VOICEVOX\VOICEVOX.exe"
if (Test-Path $VVPath -and -not (Get-Process VOICEVOX -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $VVPath -ArgumentList "--headless" -WindowStyle Minimized
}
Write-Host "  - Vocal substrates online." -ForegroundColor Green

# [4/7] Core Heartbeat: OpenClaw Gateway
Write-Host "[4/7] Booting OpenClaw Gateway..." -ForegroundColor White
if (-not (netstat -ano | findstr ":18789 ")) {
    Start-Process -FilePath "pnpm" -ArgumentList "start" -WorkingDirectory $OpenClawDir -WindowStyle Minimized
    Write-Host "  - Gateway warming up..." -ForegroundColor Gray
    Start-Sleep -Seconds 8
}
else {
    Write-Host "  - Gateway already running." -ForegroundColor White
}

# [5/7] Visual manifestations: Browser & Avatar
Write-Host "[5/7] Materializing Interfaces..." -ForegroundColor White
$Token = ""
if (Test-Path $EnvFile) {
    $TokenLine = Get-Content $EnvFile | Select-String "OPENCLAW_GATEWAY_TOKEN="
    if ($TokenLine) { $Token = $TokenLine.ToString().Split("=")[1].Trim() }
}
$UI_URL = "http://127.0.0.1:18789"
if ($Token) { $UI_URL += "/?token=$Token" }

Write-Host "  - Opening Control UI..." -ForegroundColor Gray
Start-Process "msedge.exe" -ArgumentList $UI_URL, "--no-first-run"

Write-Host "  - Summoning Desktop Avatar..." -ForegroundColor Gray
if (Test-Path "$OpenClawDir\scripts\start-avatar.bat") {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "scripts\start-avatar.bat" -WorkingDirectory $OpenClawDir -WindowStyle Minimized
}

# [6/7] Final Manifestation: VRChat Pulse
Write-Host "[6/7] Executing Final Manifestation Pulse..." -ForegroundColor Cyan
Start-Sleep -Seconds 5
if (Test-Path "$OpenClawDir\scripts\vrchat-manifestation.py") {
    py -3 "$OpenClawDir\scripts\vrchat-manifestation.py"
}

# [7/7] Brain Status Check
Write-Host "[7/7] Verifying qwen3.5-9B Brain..." -ForegroundColor White
$BrainStatus = "offline"
try {
    $BrainCheck = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -ErrorAction SilentlyContinue
    if ($BrainCheck.models -match "qwen3.5") {
        $BrainStatus = "online"
    }
} catch {}
Write-Host "  - Brain Status: $BrainStatus" -ForegroundColor $(if ($BrainStatus -eq "online") { "Green" } else { "Yellow" })

Write-Host "`n=================================================" -ForegroundColor Cyan
Write-Host " Clawdbot Master System v3.1 Online." -ForegroundColor Magenta
Write-Host " Brain: qwen3.5-9B (Multimodal)" -ForegroundColor Cyan
Write-Host " TTS: VOICEVOX" -ForegroundColor Cyan
Write-Host " Vision: Camera + qwen3.5-9B" -ForegroundColor Cyan
Write-Host " ASI_ACCEL." -ForegroundColor Magenta
Write-Host "=================================================" -ForegroundColor Cyan
Start-Sleep -Seconds 5
