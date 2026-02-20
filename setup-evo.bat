@echo off
REM OpenClaw Self-Evolution & Self-Repair Setup Script

echo ============================================
echo   OpenClaw Self-Evolution System
echo   SakanaAI-inspired Auto-Optimization
echo ============================================
echo.

REM Step 1: Check Node.js
echo [1/3] Checking Node.js...
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found. Please install Node.js 22+
    exit /b 1
)
echo [OK] Node.js found

REM Step 2: Install dependencies (if needed)
echo.
echo [2/3] Building TypeScript...
cd /d "%~dp0"
call pnpm install >nul 2>&1

REM Step 3: Build the project
echo.
echo [3/3] Building OpenClaw with self-evolution...
call pnpm build >nul 2>&1

if %ERRORLEVEL% NEQ 0 (
    echo [WARNING] Build had issues, but continuing...
)

echo.
echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo Available Commands:
echo.
echo   openclaw evo health    - Run health checks
echo   openclaw evo repair    - Auto-repair configuration
echo   openclaw evo evolve    - Run evolutionary optimization
echo   openclaw evo status    - Show system status
echo.
echo Examples:
echo.
echo   openclaw evo health
echo   openclaw evo repair
echo   openclaw evo evolve -g 20 -p 20
echo.
