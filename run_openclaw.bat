@echo off
setlocal

:: Set the custom state directory
set "OPENCLAW_STATE_DIR=F:\DOCUMENT\PROMGRAM\.openclaw"

echo Starting OpenClaw (Direct Source Mode)...
echo Data Directory: %OPENCLAW_STATE_DIR%
echo.

:: Check if dependencies are installed
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
)

:: Run the application directly using tsx
call npx tsx src/entry.ts

:: Pause on exit
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] OpenClaw exited with error code %ERRORLEVEL%.
    pause
) else (
    echo.
    echo [INFO] OpenClaw stopped properly.
    pause
)
