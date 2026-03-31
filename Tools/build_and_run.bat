@echo off
setlocal

:: 获取脚本所在目录并切换到项目根目录（Tools 的上一级）
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%.."

echo =========================================
echo Rebuilding OpenClaw Project...
echo =========================================
call pnpm build
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Build failed with exit code %ERRORLEVEL%.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo =========================================
echo Starting OpenClaw Dev Gateway...
echo =========================================
echo Running: node openclaw.mjs --dev gateway run --bind loopback --port 18789 --force
echo.

node openclaw.mjs --dev gateway run --bind loopback --port 18789 --force

echo.
pause
