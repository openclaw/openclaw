@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File d:\work\openclaw\cli\syno\zig-cc.ps1 %*
exit /b %ERRORLEVEL%
