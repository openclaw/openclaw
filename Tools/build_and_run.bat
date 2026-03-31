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
echo 0. Exit
echo =========================================
choice /C 12340 /M "Please select an option:"

if errorlevel 5 goto END
if errorlevel 4 goto ACTION_STOP_ONLY
if errorlevel 3 goto ACTION_BUILD_ONLY
if errorlevel 2 goto ACTION_BUILD_AND_START
if errorlevel 1 goto ACTION_START

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
echo Starting ABB Hardware Bridge Plugin...
echo =========================================
:: 启动 ABB 的 C# 网桥微服务 (在新窗口中运行以免阻塞)
if exist "Plugins\hw.bridge.abb\ABB.dll" (
    pushd "Plugins\hw.bridge.abb"
    start "ABB Bridge Plugin" cmd /k "dotnet ABB.dll"
    popd
    echo [INFO] ABB Plugin process started in a new cmd window.
) else (
    echo [WARNING] ABB.dll not found. Skipping plugin start.
)

echo.
echo =========================================
echo Starting OpenClaw Gateway (Standard Mode)...
echo =========================================
echo Running: node openclaw.mjs gateway run --bind loopback --port 18789 --force
echo.

node openclaw.mjs gateway run --bind loopback --port 18789 --force

echo.
pause
goto MENU

:CHECK_AND_STOP
echo.
echo Checking for running OpenClaw services...
powershell -NoProfile -Command "$sys = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue; $n = $sys | Where-Object { $_.CommandLine -match 'node.*openclaw\.mjs' }; $d = $sys | Where-Object { $_.CommandLine -match 'dotnet.*ABB\.dll' }; if ($n -or $d) { exit 1 } else { exit 0 }"
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
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'node.*openclaw\.mjs|dotnet.*ABB\.dll' }; if ($procs) { $procs | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }"
taskkill /F /FI "WINDOWTITLE eq ABB Bridge Plugin*" >nul 2>&1
:: Ensure port 18789 is freed
for /f "tokens=5" %%a in ('netstat -ano ^| findstr LISTENING ^| findstr :18789') do (
    if not "%%a" == "0" taskkill /F /PID %%a >nul 2>&1
)
exit /b

:END
exit /b
