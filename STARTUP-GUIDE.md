# 🚀 GenSparx Project - Quick Start Guide

## How to Run the Project

### Option 1: Using PowerShell Script (EASIEST)

```powershell
# Navigate to project folder, then run:
.\START-GATEWAY.ps1
```

### Option 2: Manual Command

```powershell
# From project root directory (c:\Users\Shubham\OneDrive\Desktop\openclaw)
$env:OPENCLAW_GATEWAY_TOKEN="devtoken"
node scripts/run-node.mjs --dev gateway --bind loopback --allow-unconfigured
```

## Access the Gateway

Once the gateway is running (wait 30-60 seconds for startup):

**🌐 Open in browser:**

```
http://127.0.0.1:19001/?token=devtoken
```

## What You'll See

✅ **GenSparx** navbar (rebranded from OpenClaw)
✅ Control UI Dashboard
✅ WhatsApp and other channels configured
✅ Agent configuration interface

## Stopping the Gateway

**Press Ctrl+C** in the terminal to stop the gateway

## Troubleshooting

### Gateway won't start?

1. Kill existing node processes: `Get-Process node | Stop-Process -Force`
2. Make sure port 19001 is not in use
3. Try: `pnpm install` then run the startup script again

### Can't see the UI?

1. Wait 30-60 seconds for build to complete
2. Refresh the browser (F5 or Ctrl+R)
3. Check the terminal for any error messages

### Browser shows connection refused?

1. Check terminal to confirm gateway is running
2. Make sure you're using: `http://` (not https)
3. Verify token in URL: `?token=devtoken`

## Project Structure

- `/src` - Source code (TypeScript)
- `/dist` - Compiled output
- `/ui` - Web UI components
- `/apps` - Mobile apps (iOS, Android, macOS)
- `/extensions` - Channel extensions (Discord, Telegram, Matrix, etc.)

## Build Without Running

To just rebuild without starting gateway:

```powershell
npx tsdown
```

---

**Last Updated:** February 6, 2026
**Brand:** GenSparx (forked from OpenClaw)
**BASICALLY:-**

$env:OPENCLAW_GATEWAY_TOKEN='devtoken'; node scripts/run-node.mjs --dev gateway --bind loopback --allow-unconfigured

**USING POWERSHELLL SCRIPT:-**
.\START-GATEWAY.ps1
