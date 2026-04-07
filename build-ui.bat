@echo off
echo ============================================
echo   Building Kasai Control UI
echo ============================================
echo.

cd /d "%~dp0ui"

echo Installing UI dependencies...
call pnpm install
if errorlevel 1 (
    echo.
    echo Install failed! Make sure pnpm is installed: npm install -g pnpm
    pause
    exit /b 1
)

echo.
echo Building UI...
call pnpm run build
if errorlevel 1 (
    echo.
    echo Build failed!
    pause
    exit /b 1
)

echo.
echo ============================================
echo   UI built successfully!
echo   Output: dist\control-ui\
echo ============================================
pause
