# Start Tim's Email Listener with AgentMail
# Usage: .\start-listener.ps1

# Set environment variables
Write-Host "Setting up environment for AgentMail..." -ForegroundColor Green

$env:AGENTMAIL_API_KEY="am_us_2152135269b7ca63bddf3123c8719b65878f4f07a9167161313f73c9e34be0e8"

# Prompt for Anthropic API key if not set
if (-not $env:ANTHROPIC_API_KEY) {
    Write-Host "Please enter your Anthropic API key (sk-ant-...): " -NoNewline
    $env:ANTHROPIC_API_KEY = Read-Host
}

Write-Host "Environment variables set:" -ForegroundColor Green
Write-Host "  AGENTMAIL_API_KEY: Set ✓"
Write-Host "  ANTHROPIC_API_KEY: Set ✓"
Write-Host ""

# Build if needed
if (-not (Test-Path "dist")) {
    Write-Host "Building email listener..." -ForegroundColor Cyan
    npm run build
}

# Start the listener
Write-Host "Starting Tim's Email Listener..." -ForegroundColor Green
Write-Host "Listening for emails on: timsmail@agentmail.to" -ForegroundColor Green
Write-Host ""
Write-Host "Press Ctrl+C to stop the listener" -ForegroundColor Yellow
Write-Host ""

node --import tsx ./src/index.ts
