@echo off
REM Daily news pipeline runner (Windows)
REM Usage: scripts\run-news.cmd

cd /d "%~dp0.."

REM Load env
if exist .env for /f "usebackaliases tokens=1,* delims==" %%a in (.env) do set "%%a=%%b"

echo %date% %time% — Starting news pipeline...
npx tsx src/cli.ts run news --skip-upload 2>&1

echo %date% %time% — Pipeline complete!
