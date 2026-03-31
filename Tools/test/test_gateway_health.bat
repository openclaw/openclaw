@echo off
setlocal

:: 切到项目根目录（Tools\test\ 的上两级）
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%..\.."

echo =======================================
echo Testing OpenClaw Gateway Health
echo =======================================
echo.
echo URL: http://127.0.0.1:18789/__openclaw__/api/health
echo.

:: 使用 PowerShell 请求 health 接口
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:18789/__openclaw__/api/health' -Method Get -ErrorAction Stop; Write-Host '[' -NoNewline; Write-Host 'OK' -ForegroundColor Green -NoNewline; Write-Host '] Gateway is healthy!'; echo $response | ConvertTo-Json -Depth 3 } catch { Write-Host '[' -NoNewline; Write-Host 'FAIL' -ForegroundColor Red -NoNewline; Write-Host '] Gateway unreachable. Is it running?'; Write-Host $_.Exception.Message }"

echo.
pause
