@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%.."

echo Running: node openclaw.mjs --dev plugins --help
echo.

node openclaw.mjs --dev plugins --help

echo.
pause
