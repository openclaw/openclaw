# GenSparx Gateway Startup Script
# Usage: Run this PowerShell script to start the gateway on localhost:19001

Write-Host "╔════════════════════════════════════════════════════════════════╗"
Write-Host "║  GenSparx Gateway Startup                                     ║"
Write-Host "╚════════════════════════════════════════════════════════════════╝"
Write-Host ""

# Change to project directory
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "📁 Project directory: $projectRoot"
Write-Host ""

# Kill any existing gateway processes
Write-Host "🛑 Cleaning up existing processes..."
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Set gateway token
Write-Host "🔑 Setting gateway token..."
$env:OPENCLAW_GATEWAY_TOKEN="devtoken"

# Start the gateway
Write-Host "🚀 Starting GenSparx Gateway..."
Write-Host ""
Write-Host "This will take 30-60 seconds to build and start..."
Write-Host ""

node scripts/run-node.mjs --dev gateway --bind loopback --allow-unconfigured

Write-Host ""
Write-Host "⚠️  To stop the gateway: Press Ctrl+C"
