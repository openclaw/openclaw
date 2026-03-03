# install-vbcable.ps1 — Downloads and installs VB-Cable Virtual Audio Device
# Requires: Run as Administrator

$ErrorActionPreference = "Stop"
$DownloadUrl = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip"
$TempDir = "$env:TEMP\vbcable-install"
$ZipPath = "$TempDir\VBCABLE_Driver_Pack45.zip"

Write-Host "[Hakua] Installing VB-Cable Virtual Audio Device..." -ForegroundColor Cyan

# Check if already installed
$existingDevice = Get-CimInstance Win32_SoundDevice | Where-Object { $_.Name -like "*VB-Audio*" -or $_.Name -like "*CABLE*" }
if ($existingDevice) {
    Write-Host "[Hakua] VB-Cable is already installed!" -ForegroundColor Green
    Write-Host "  Device: $($existingDevice.Name)" -ForegroundColor Gray
    exit 0
}

# Check admin privileges
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")
if (-not $isAdmin) {
    Write-Host "[Hakua] Error: This script must be run as Administrator." -ForegroundColor Red
    Write-Host "  Right-click PowerShell -> 'Run as Administrator' and try again." -ForegroundColor Yellow
    exit 1
}

# Download
if (-not (Test-Path $TempDir)) { New-Item -ItemType Directory -Path $TempDir -Force | Out-Null }
Write-Host "  Downloading VB-Cable Driver Pack..." -ForegroundColor White
Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipPath -UseBasicParsing

# Extract
Write-Host "  Extracting..." -ForegroundColor White
Expand-Archive -Path $ZipPath -DestinationPath $TempDir -Force

# Install (64-bit)
$SetupExe = "$TempDir\VBCABLE_Setup_x64.exe"
if (-not (Test-Path $SetupExe)) {
    $SetupExe = Get-ChildItem -Path $TempDir -Recurse -Filter "VBCABLE_Setup_x64.exe" | Select-Object -First 1 -ExpandProperty FullName
}

if (-not $SetupExe -or -not (Test-Path $SetupExe)) {
    Write-Host "[Hakua] Error: Could not find VBCABLE_Setup_x64.exe in downloaded package." -ForegroundColor Red
    exit 1
}

Write-Host "  Running installer (a Windows Security dialog may appear)..." -ForegroundColor Yellow
Start-Process -FilePath $SetupExe -ArgumentList "-i", "-h" -Wait -Verb RunAs

Write-Host ""
Write-Host "[Hakua] VB-Cable installation complete!" -ForegroundColor Green
Write-Host "  IMPORTANT: Please set VRChat's microphone input to 'CABLE Output (VB-Audio Virtual Cable)'" -ForegroundColor Cyan
Write-Host "  A reboot may be required for the device to appear." -ForegroundColor Yellow

# Cleanup
Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
