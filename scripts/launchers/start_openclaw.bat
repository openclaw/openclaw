@echo off
title OpenClaw Launcher (Hakua)
cd /d "%~dp0"
echo ===================================================
echo  OpenClaw Integrated Launcher
echo ===================================================

REM Use the PowerShell launcher which handles Ngrok and Browser
powershell -ExecutionPolicy Bypass -File "launch-with-browser.ps1"
pause
