@echo off
REM v2.0 - Full Automation with Browser Control
title Clawdbot-Loader
chcp 65001 > NUL

set REPO_ROOT=%~dp0..
cd /d "%REPO_ROOT%"

echo ---------------------------------------------------
echo  Clawdbot Full Automation v2.0
echo ---------------------------------------------------

REM 0. Generate Token if not exists
if not exist ".env" goto :NOENV
findstr /C:"CLAWDBOT_GATEWAY_TOKEN=" .env >nul
if %errorlevel%==0 goto :ENVOK
:NOENV
echo Generating gateway token...
powershell -Command "$t=-join((65..90)+(97..122)+(48..57)|Get-Random -Count 32|%{[char]$_});Add-Content '.env' -Value \"CLAWDBOT_GATEWAY_TOKEN=$t\";Write-Host \"Token: $t\""
:ENVOK
call .env 2>nul

REM 1. SBV2
echo [1/4] Checking SBV2 TTS Server
netstat -ano | findstr ":5000 " >nul
if not errorlevel 1 goto :SBV2_OK
echo Starting SBV2...
start "SBV2" /MIN cmd /c "cd /d %REPO_ROOT% && scripts\start-sbv2.bat"
:WAIT_SBV2
timeout /t 2 >nul
netstat -ano | findstr ":5000 " >nul
if errorlevel 1 goto :WAIT_SBV2
:SBV2_OK
echo SBV2 Online.

REM 2. Gateway
echo [2/4] Starting OpenClaw Gateway on port 18789...
set OPENCLAW_GATEWAY_PORT=18789

netstat -ano | findstr ":18789 " >nul
if not errorlevel 1 goto :GW_ALREADY_RUNNING

echo Launching Gateway...
start "OpenClaw-Gateway" cmd /k "cd /d %REPO_ROOT% && set OPENCLAW_GATEWAY_PORT=18789 && pnpm start"

echo Waiting for Gateway (max 60s)...
set GW_COUNT=0
:WAIT_GW
timeout /t 2 >nul
set /a GW_COUNT+=2
echo   Waiting... %GW_COUNT%s
netstat -ano | findstr ":18789 " >nul
if errorlevel 1 (
    if %GW_COUNT% GEQ 60 goto :GW_TIMEOUT
    goto :WAIT_GW
)
echo Gateway Online.
goto :GW_DONE

:GW_ALREADY_RUNNING
echo Gateway already running.
:GW_TIMEOUT

:GW_DONE

REM 3. Browser Control (Edge)
echo [3/4] Launching Browser Control...
set EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
set BROWSER_URL=http://127.0.0.1:18791/

if exist "%EDGE_PATH%" (
    start "" "%EDGE_PATH%" "%BROWSER_URL%" --no-first-run --disable-extensions --disable-sync
) else (
    start "" "%BROWSER_URL%"
)

REM 4. Avatar Window
echo [4/4] Launching Avatar Window
if exist "scripts\start-avatar.bat" call "scripts\start-avatar.bat"

echo.
echo ===================================================
echo  All Systems Online
echo ===================================================
echo.
echo Gateway: http://127.0.0.1:18789
echo Browser: http://127.0.0.1:18791
echo Avatar:  http://127.0.0.1:3333
echo SBV2:    http://localhost:5000
echo.
echo Press any key to exit this window...
pause >nul
