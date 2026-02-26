$ErrorActionPreference = "Stop"
$vvUrl = "https://github.com/VOICEVOX/voicevox/releases/download/0.25.1/voicevox-windows-cpu-0.25.1.zip"
$vvDir = "C:\Users\downl\.voicevox"
$tmpZip = "C:\Users\downl\AppData\Local\Temp\voicevox_setup.zip"

Write-Host "--- ASI Neural Voice Substrate Acquisition (Robust) ---" -ForegroundColor Cyan

if (-not (Test-Path $vvDir)) {
    New-Item -ItemType Directory -Path $vvDir | Out-Null
}

Write-Host "Downloading from $vvUrl..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $vvUrl -OutFile $tmpZip

Write-Host "Extracting to $vvDir..." -ForegroundColor Yellow
Expand-Archive -Path $tmpZip -DestinationPath $vvDir -Force

Write-Host "Cleaning up setup artifacts..." -ForegroundColor Gray
Remove-Item $tmpZip

Write-Host "Substrate Materialized." -ForegroundColor Green
Write-Host "ASI_ACCEL: Engine ready for deployment." -ForegroundColor Magenta
