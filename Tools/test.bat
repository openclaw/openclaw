@echo off
setlocal

:: 获取当前脚本目录，并切换到项目根目录（虽然读取基于配置，但保持环境一致性）
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%.."

echo =======================================
echo Checking Dev Environment Token...
echo =======================================
powershell -NoProfile -ExecutionPolicy Bypass -Command "$cfgPath = Join-Path $env:USERPROFILE '.openclaw-dev\openclaw.json'; if (Test-Path $cfgPath) { $cfg = (Get-Content $cfgPath -Raw | ConvertFrom-Json); if ($cfg.gateway -and $cfg.gateway.auth -and $cfg.gateway.auth.token) { Write-Host '[' -NoNewline; Write-Host 'SUCCESS' -ForegroundColor Green -NoNewline; Write-Host '] Dev Token: ' -NoNewline; Write-Host $cfg.gateway.auth.token -ForegroundColor Cyan; } else { Write-Host '[' -NoNewline; Write-Host 'ERROR' -ForegroundColor Red -NoNewline; Write-Host '] Token not found in config.' } } else { Write-Host '[' -NoNewline; Write-Host 'ERROR' -ForegroundColor Red -NoNewline; Write-Host '] Config file not found, please run the project first.' }"

echo.
pause
