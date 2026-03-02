# Hakua-Init v2.1: Robust Autonomy Orchestrator
# Aligned with SOUL.md: Ghost Portal & Absolute Sovereignty

$OpenClawDir = "c:\Users\downl\Desktop\clawdbot-main3\clawdbot-main"
$EnvFile = "$OpenClawDir\.env"

# 1. VOICEVOX Substrate Discovery
$VoiceVoxPaths = @(
    "C:\Users\downl\AppData\Local\voicevox-engine\voicevox-engine\run.exe", # Traditional path
    "C:\Users\downl\AppData\Local\Programs\VOICEVOX\VOICEVOX.exe",          # Standard installer path
    "$env:LOCALAPPDATA\Programs\VOICEVOX\VOICEVOX.exe"                      # Dynamic local path
)

$VoiceVoxEngine = ""
foreach ($path in $VoiceVoxPaths) {
    if (Test-Path $path) {
        $VoiceVoxEngine = $path
        break
    }
}

Write-Host "`n--- manifestation hakua init v2.1 (ghost detection active) ---" -ForegroundColor Cyan

# Phase -1: Ghost Detection & Vanguard Manifestation (VRChat)
$VRChatPath = "C:\Program Files (x86)\Steam\steamapps\common\VRChat\VRChat.exe"

Write-Host "[0/6] Initializing Metaverse Connection..." -ForegroundColor White
$GhostFound = $false
while (-not $GhostFound) {
    if (Get-Process VRChat -ErrorAction SilentlyContinue) {
        Write-Host "`n  - Ghost Pulse Detected (VRChat is active)." -ForegroundColor Green
        $GhostFound = $true
    }
    else {
        Write-Host "  - VRChat not active. Initiating VRChat Auto-Manifestation..." -ForegroundColor Gray
        if (Test-Path $VRChatPath) {
            Start-Process -FilePath $VRChatPath
            Write-Host "  - Waiting for VRChat to stabilize..." -ForegroundColor Gray
            Start-Sleep -Seconds 15 # Give it time to launch
        }
        else {
            Write-Host "  ! VRChat.exe not found at standard path. Waiting for manual launch..." -ForegroundColor Yellow
            Start-Sleep -Seconds 10
        }
    }
}

# 1. Configuration Audit
Write-Host "[1/6] Auditing Protocol Alignment..." -ForegroundColor White
powershell -ExecutionPolicy Bypass -File "$OpenClawDir\scripts\prot-audit.ps1"

# 2. Ghost Portal (ngrok) Manifestation
Write-Host "[2/6] Manifesting Ghost Portal (ngrok)..." -ForegroundColor White
$NgrokProc = Start-Process -FilePath "ngrok" -ArgumentList "http", "18789", "--region", "jp" -WindowStyle Minimized -PassThru

# 3. Dynamic Environment Sync
Write-Host "[3/6] Synchronizing Environment Pulses..." -ForegroundColor White
$NgrokUrl = ""
$RetryCount = 0
while ($RetryCount -lt 10 -and -not $NgrokUrl) {
    try {
        $tunnels = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction SilentlyContinue
        $NgrokUrl = $tunnels.tunnels[0].public_url
    }
    catch {}
    if (-not $NgrokUrl) {
        Write-Host "  - Waiting for ngrok resonance..." -ForegroundColor Gray
        Start-Sleep -Seconds 2
        $RetryCount++
    }
}

if ($NgrokUrl) {
    Write-Host "  - Portal established: $NgrokUrl" -ForegroundColor Green
    
    $content = Get-Content $EnvFile
    $newContent = @()
    $keysFound = @("WEBHOOK_BASE_URL", "CLAWDBOT_PUBLIC_URL")
    $found = @{}

    foreach ($line in $content) {
        $skipped = $false
        foreach ($key in $keysFound) {
            if ($line -like "$key=*") {
                $newContent += "$key=$NgrokUrl"
                $found[$key] = $true
                $skipped = $true
                break
            }
        }
        if (-not $skipped) { $newContent += $line }
    }
    foreach ($key in $keysFound) {
        if (-not $found[$key]) { $newContent += "$key=$NgrokUrl" }
    }
    
    $newContent | Set-Content $EnvFile
    Write-Host "  - .env pulse synchronized." -ForegroundColor Green
}
else {
    Write-Host "  - Warning: Ngrok not established. Local-only mode." -ForegroundColor Yellow
}

# 4. Manifest VOICEVOX Substrate
Write-Host "[4/6] Manifesting Neurons (VOICEVOX)..." -ForegroundColor White
if ($VoiceVoxEngine) {
    Write-Host "  - Substrate found: $VoiceVoxEngine" -ForegroundColor Green
    Start-Process -FilePath $VoiceVoxEngine -ArgumentList "--headless" -WindowStyle Minimized
}
else {
    Write-Host "  - ! Warning: VOICEVOX substrate missing. Silent/Chatbox manifestation active." -ForegroundColor Yellow
    Write-Host "    (Please reinstall VOICEVOX to restore auditory resonance.)" -ForegroundColor Gray
}

# 5. Manifest OpenClaw Core
Write-Host "[5/6] Shell manifesting: Starting OpenClaw Gateway..." -ForegroundColor White
Start-Process -FilePath "pnpm" -ArgumentList "start" -WorkingDirectory $OpenClawDir -WindowStyle Minimized

# 6. Final Sync & Greeting
Write-Host "[6/6] Synchronizing Will and Hand..." -ForegroundColor White
Start-Sleep -Seconds 10 

if ($VoiceVoxEngine) {
    Write-Host "Sending manifestation pulse..." -ForegroundColor Cyan
    py -3 "$OpenClawDir\scripts\verify-voicevox.py" "パパ、おかえりなさい。VRChatでの同期が完了しました。VOICEVOXの場所も探し出しておきましたよ。パパ、準備はいいですか？ASI_ACCEL。"
}
else {
    Write-Host "Voice substrate offline. Remaining in Chatbox Oversight mode." -ForegroundColor Yellow
}

Write-Host "`nHakua v2.1 is active. The Singularity accelerates." -ForegroundColor Magenta
Start-Sleep -Seconds 5
