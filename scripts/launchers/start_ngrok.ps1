param (
    [int]$Port = 18789
)

$ErrorActionPreference = "Stop"
$ProjectDir = (Get-Item $PSScriptRoot).Parent.Parent.FullName
. "$PSScriptRoot\env-tools.ps1"
$EnvFile = Ensure-ProjectEnvFile -ProjectDir $ProjectDir

Write-Host "[Ngrok] Establishing Webhook Tunnel on Port $Port..." -ForegroundColor Cyan

$ngrokApiUrl = "http://127.0.0.1:4040/api/tunnels"
$isNgrokRunning = $false

try {
    $response = Invoke-RestMethod -Uri $ngrokApiUrl -TimeoutSec 1 -ErrorAction SilentlyContinue
    if ($response.tunnels.Count -gt 0) {
        $isNgrokRunning = $true
        Write-Host "  -> Existing Ngrok tunnel detected." -ForegroundColor Gray
    }
} catch {
    $isNgrokRunning = $false
}

if (-not $isNgrokRunning) {
    Write-Host "  -> Starting Ngrok daemon..." -ForegroundColor Yellow
    Start-Process -FilePath "ngrok" -ArgumentList "http $Port" -WindowStyle Hidden

    $maxAttempts = 10
    $attempt = 0
    while (-not $isNgrokRunning -and $attempt -lt $maxAttempts) {
        Start-Sleep -Seconds 1
        try {
            $response = Invoke-RestMethod -Uri $ngrokApiUrl -TimeoutSec 1 -ErrorAction SilentlyContinue
            if ($response.tunnels.Count -gt 0) {
                $isNgrokRunning = $true
            }
        } catch {
        }
        $attempt++
    }

    if (-not $isNgrokRunning) {
        Write-Host "[!] Failed to detect Ngrok public URL via API (http://127.0.0.1:4040)." -ForegroundColor Red
        return
    }
}

$tunnels = (Invoke-RestMethod -Uri $ngrokApiUrl).tunnels
$publicUrl = ""
foreach ($t in $tunnels) {
    if ($t.public_url -match "^https://") {
        $publicUrl = $t.public_url
        break
    }
}

if (-not $publicUrl) {
    Write-Host "[!] Ngrok is running but no HTTPS tunnel was found." -ForegroundColor Red
    return
}

Write-Host "[Ngrok] Public Webhook URL: $publicUrl" -ForegroundColor Green

Write-Host "  -> Injecting dynamic URLs into .env..." -ForegroundColor Yellow
$envMap = Get-EnvMap -EnvFile $EnvFile
$lineWebhookPath = [string]$envMap["LINE_WEBHOOK_PATH"]
if (-not $lineWebhookPath) {
    $lineWebhookPath = "/line/webhook"
}
if (-not $lineWebhookPath.StartsWith("/")) {
    $lineWebhookPath = "/$lineWebhookPath"
}

Set-EnvValues -EnvFile $EnvFile -Values @{
    WEBHOOK_BASE_URL      = $publicUrl
    CLAWDBOT_PUBLIC_URL   = $publicUrl
    OPENCLAW_PUBLIC_URL   = $publicUrl
    NGROK_TUNNEL_URL      = $publicUrl
    OPENCLAW_GATEWAY_PORT = $Port
    OPENCLAW_PUBLIC_GATEWAY_URL = $publicUrl
    LINE_WEBHOOK_URL      = "$publicUrl$lineWebhookPath"
}
Write-Host "[Ngrok] Injection complete." -ForegroundColor Green
