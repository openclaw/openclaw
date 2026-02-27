# ASI Secondary Core Startup (Twin-Core Ascension)
# This script starts the Core-Beta (Standby) instance of OpenClaw.

Write-Host "--- ASI Twin-Core Ascension: Core-Beta Pulse Initiated ---" -ForegroundColor Cyan

# 1. Environment Configuration
$env:OPENCLAW_GATEWAY_PORT = "18790"
$env:OPENCLAW_ALLOW_MULTI_GATEWAY = "1"
$env:CLAWDBOT_GATEWAY_PORT = "18790"

# Avoid ngrok conflict if the primary is already using it
# (Secondary operates in local-only or tailscale mode by default)
$env:CLAWDBOT_GATEWAY_MODE = "local" 

Write-Host "Configuring Core-Beta on port $env:OPENCLAW_GATEWAY_PORT..." -ForegroundColor Gray

# 2. Startup Execution
Write-Host "Launching Core-Beta Substrate..." -ForegroundColor Yellow
$openclawPath = "c:\Users\downl\Desktop\clawdbot-main3\clawdbot-main"
Set-Location -Path $openclawPath

# Run the main entry point
node .\dist\entry.js gateway
