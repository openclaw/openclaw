@echo off
setlocal

:: 获取脚本所在目录并切换到项目根目录（Tools 的上一级）
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%.."

:MENU
cls
echo =========================================
echo          OpenClaw Action Menu
echo =========================================
echo 1. Start OpenClaw (Skip Build)
echo 2. Build and Start OpenClaw
echo 3. Only Build Project
echo 4. Stop Running OpenClaw Services
echo 5. Disable Security Interception (No Prompts)
echo 6. Enable Security Interception (Default)
echo 0. Exit
echo =========================================
choice /C 1234560 /M "Please select an option:"

if errorlevel 7 goto END
if errorlevel 6 goto ACTION_ENABLE_SECURITY
if errorlevel 5 goto ACTION_DISABLE_SECURITY
if errorlevel 4 goto ACTION_STOP_ONLY
if errorlevel 3 goto ACTION_BUILD_ONLY
if errorlevel 2 goto ACTION_BUILD_AND_START
if errorlevel 1 goto ACTION_START

:ACTION_DISABLE_SECURITY
echo.
echo =========================================
echo Disabling Gateway Security Interception...
echo =========================================
call node openclaw.mjs config set tools.exec.ask off
call node openclaw.mjs config set tools.exec.security full
echo [INFO] Gateway security interception disabled. (Requires OpenClaw restart)
pause
goto MENU

:ACTION_ENABLE_SECURITY
echo.
echo =========================================
echo Enabling Gateway Security Interception...
echo =========================================
call node openclaw.mjs config set tools.exec.ask on-miss
call node openclaw.mjs config set tools.exec.security allowlist
echo [INFO] Gateway security interception enabled. (Requires OpenClaw restart)
pause
goto MENU

:ACTION_START
set "ABORT_START=0"
call :CHECK_AND_STOP
if "%ABORT_START%"=="1" goto MENU
goto START_SERVICES

:ACTION_BUILD_AND_START
set "ABORT_START=0"
call :CHECK_AND_STOP
if "%ABORT_START%"=="1" goto MENU
echo.
echo =========================================
echo Rebuilding OpenClaw Project...
echo =========================================
call pnpm build
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Build failed with exit code %ERRORLEVEL%.
    pause
    goto MENU
)
goto START_SERVICES

:ACTION_BUILD_ONLY
echo.
echo =========================================
echo Rebuilding OpenClaw Project...
echo =========================================
call pnpm build
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Build failed.
) else (
    echo.
    echo [SUCCESS] Build completed successfully.
)
pause
goto MENU

:ACTION_STOP_ONLY
echo.
call :STOP_SERVICES_SILENT
echo [INFO] Existing services have been stopped.
pause
goto MENU

:START_SERVICES

echo.
echo =========================================
echo Starting OpenClaw Gateway (Standard Mode)...
echo =========================================
echo (Note: ABB Bridge Plugin is now automatically managed via MCP)
echo Running: node openclaw.mjs gateway run --bind loopback --port 18789 --force
echo.

:: 使用 powershell 调用 node，这样按下 Ctrl+C 时可以避免出现“是否终止批处理”选项
powershell -NoProfile -Command "node openclaw.mjs gateway run --bind loopback --port 18789 --force"

echo.
echo [INFO] OpenClaw service stopped.
pause
goto MENU

:CHECK_AND_STOP
echo.
echo Checking for running OpenClaw services...
powershell -NoProfile -Command "$sys = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue; $n = $sys | Where-Object { $_.CommandLine -match 'node.*openclaw\.mjs' }; $d = $sys | Where-Object { $_.Name -match 'ABB\.exe' }; if ($n -or $d) { exit 1 } else { exit 0 }"
if %ERRORLEVEL% equ 1 (
    echo [WARNING] OpenClaw or ABB Plugin is already running!
    choice /C YN /M "Do you want to fully stop the existing services before starting?"
    if errorlevel 2 (
        set "ABORT_START=1"
        exit /b
    )
    if errorlevel 1 call :STOP_SERVICES_SILENT
)
exit /b

:STOP_SERVICES_SILENT
echo Stopping OpenClaw and ABB Plugin processes...
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'node.*openclaw\.mjs' -or $_.Name -match 'ABB\.exe' }; if ($procs) { $procs | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }"
taskkill /F /IM ABB.exe >nul 2>&1
:: Ensure port 18789 is freed
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr :18789') do (
    if not "%%a" == "0" taskkill /F /PID %%a >nul 2>&1
)
exit /b

:END
exit /b
