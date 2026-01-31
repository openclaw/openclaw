@echo off
setlocal

:: Set the custom state directory
set "OPENCLAW_STATE_DIR=F:\DOCUMENT\PROMGRAM\.openclaw"

echo Starting OpenClaw Setup Wizard (Direct Source Mode)...
echo This skips the build process and runs the code directly.
echo.

:: Run the onboard command directly using tsx
:: This bypasses the need for pnpm or a full build
call npx tsx src/entry.ts onboard

:: Pause to let user see the result
pause
