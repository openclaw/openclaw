# Ngrok URL Sync Utility
# Fetches the public URL from the local ngrok API and updates .env

$ErrorActionPreference = "SilentlyContinue"
$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName
$EnvFile = Join-Path $ProjectDir ".env"

Write-Host "--- Syncing Ngrok URL ---" -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -Method Get -TimeoutSec 2
    $publicUrl = $response.tunnels[0].public_url

    if ($publicUrl) {
        Write-Host "Found Ngrok Public URL: $publicUrl" -ForegroundColor Green
        
        if (Test-Path $EnvFile) {
            $envContent = Get-Content $EnvFile
            $newContent = @()
            $found = $false

            foreach ($line in $envContent) {
                if ($line -match "^CLAWDBOT_PUBLIC_URL=") {
                    $newContent += "CLAWDBOT_PUBLIC_URL=$publicUrl"
                    $found = $true
                }
                else {
                    $newContent += $line
                }
            }

            if (-not $found) {
                $newContent += "CLAWDBOT_PUBLIC_URL=$publicUrl"
            }

            $newContent | Set-Content $EnvFile
            Write-Host "Updated .env with new CLAWDBOT_PUBLIC_URL" -ForegroundColor Gray
        }
    }
    else {
        Write-Host "No active Ngrok tunnels found." -ForegroundColor Yellow
    }
}
catch {
    Write-Host "Could not connect to Ngrok API. Is Ngrok running?" -ForegroundColor Red
}
