@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%.."

set "OPENCLAW_DIR=%CD%"

if not exist "%OPENCLAW_DIR%\openclaw.mjs" (
	echo [ERROR] openclaw.mjs not found under: %OPENCLAW_DIR%
	pause
	exit /b 1
)

echo OPENCLAW_DIR=%OPENCLAW_DIR%
echo Starting OpenClaw Dev Dashboard...
node openclaw.mjs --dev dashboard --no-open

echo.
echo ========================================================
echo Dev Gateway Token:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$cfgPath = Join-Path $env:USERPROFILE '.openclaw-dev\openclaw.json'; if (Test-Path $cfgPath) { $cfg = (Get-Content $cfgPath -Raw | ConvertFrom-Json); if ($cfg.gateway -and $cfg.gateway.auth -and $cfg.gateway.auth.token) { $cfg.gateway.auth.token } else { 'TOKEN_NOT_FOUND' } } else { 'CONFIG_NOT_FOUND' }"
echo ========================================================

pause
