# OpenClaw Windows Build Script
# Creates a distributable Windows package with WinSW

param(
    [string]$Version = "dev",
    [string]$OutputDir = "dist\windows",
    [switch]$SkipBuild,
    [switch]$CreateZip
)

$ErrorActionPreference = "Stop"

# Colors for output
function Write-Step { param($msg) Write-Host "[STEP] $msg" -ForegroundColor Cyan }
function Write-Info { param($msg) Write-Host "       $msg" -ForegroundColor Gray }
function Write-Done { param($msg) Write-Host "[DONE] $msg" -ForegroundColor Green }
function Write-Fail { param($msg) Write-Host "[FAIL] $msg" -ForegroundColor Red }

# Check prerequisites
Write-Step "Checking prerequisites..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js not found. Please install Node.js 22+ first."
    exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Info "Installing pnpm..."
    npm install -g pnpm
}

$nodeVersion = node --version
Write-Info "Node.js version: $nodeVersion"

# Build OpenClaw if not skipped
if (-not $SkipBuild) {
    Write-Step "Building OpenClaw..."
    
    pnpm install --frozen-lockfile
    pnpm build
    
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Build failed!"

    }
           exit 1 Write-Done "Build complete"
}

# Download WinSW
Write-Step "Downloading WinSW..."
$winswVersion = "v2.12.0"
$winswUrl = "https://github.com/winsw/winsw/releases/download/$winswVersion/WinSW-x64.exe"
$winswPath = "third_party\winsw\WinSW-x64.exe"

if (-not (Test-Path $winswPath)) {
    New-Item -ItemType Directory -Force -Path "third_party\winsw" | Out-Null
    Invoke-WebRequest -Uri $winswUrl -OutFile $winswPath
    Write-Info "WinSW downloaded"
}

# Verify WinSW
$sha256 = (Get-FileHash $winswPath -Algorithm SHA256).Hash
Write-Info "WinSW SHA256: $sha256"

# Create output directory
Write-Step "Creating distribution package..."
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# Copy built files
Copy-Item -Path "dist\*" -Destination $OutputDir -Recurse -Force

# Copy WinSW (renamed to openclaw-gateway.exe)
Copy-Item -Path $winswPath -Destination "$OutputDir\openclaw-gateway.exe" -Force

# Copy WinSW config template
if (Test-Path "third_party\winsw\openclaw-gateway.xml") {
    Copy-Item -Path "third_party\winsw\openclaw-gateway.xml" -Destination $OutputDir -Force
}

# Copy license
if (Test-Path "third_party\winsw\LICENSE") {
    Copy-Item -Path "third_party\winsw\LICENSE" -Destination $OutputDir -Force
}

# Create SHA256 checksum
$zipPath = "OpenClaw-windows-$Version.zip"
if ($CreateZip) {
    Write-Step "Creating ZIP archive..."
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path "$OutputDir\*" -DestinationPath $zipPath -Force
    
    $zipSha256 = (Get-FileHash $zipPath -Algorithm SHA256).Hash
    "$zipSha256  $zipPath" | Out-File -FilePath "sha256.txt" -Encoding UTF8
    
    Write-Done "Created: $zipPath"
    Write-Info "SHA256: $zipSha256"
} else {
    Write-Done "Package created in: $OutputDir"
}

# Summary
Write-Host ""
Write-Host "======================================" -ForegroundColor Yellow
Write-Host "  Build Summary" -ForegroundColor Yellow
Write-Host "======================================" -ForegroundColor Yellow
Write-Host "  Version:     $Version"
Write-Host "  Output:     $OutputDir"
if ($CreateZip) {
    Write-Host "  Archive:    $zipPath"
}
Write-Host "  WinSW:      $sha256"
Write-Host "======================================" -ForegroundColor Yellow
