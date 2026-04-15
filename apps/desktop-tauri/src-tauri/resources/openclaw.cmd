@echo off
setlocal
set "INSTALL_DIR=%~dp0"
set "OPENCLAW_VERSION=2026.4.16-beta1"
set "OPENCLAW_RUNTIME_DIR=%LOCALAPPDATA%\OpenClaw\runtime\%OPENCLAW_VERSION%"
set "OPENCLAW_INDEX_JS=%OPENCLAW_RUNTIME_DIR%\dist\index.js"
set "OPENCLAW_READY=%OPENCLAW_RUNTIME_DIR%\.runtime-ready"

if exist "%OPENCLAW_INDEX_JS%" if exist "%OPENCLAW_READY%" goto run

if not exist "%INSTALL_DIR%openclaw-runtime.tar.gz" (
  echo OpenClaw runtime archive is missing from "%INSTALL_DIR%". 1>&2
  exit /b 1
)

where tar.exe >nul 2>nul
if errorlevel 1 (
  echo OpenClaw requires tar.exe to unpack the bundled runtime. 1>&2
  exit /b 1
)

rmdir /s /q "%OPENCLAW_RUNTIME_DIR%" >nul 2>nul
mkdir "%OPENCLAW_RUNTIME_DIR%" >nul 2>nul
tar.exe -xzf "%INSTALL_DIR%openclaw-runtime.tar.gz" -C "%OPENCLAW_RUNTIME_DIR%"
if errorlevel 1 (
  echo Failed to unpack OpenClaw runtime into "%OPENCLAW_RUNTIME_DIR%". 1>&2
  exit /b 1
)
echo %OPENCLAW_VERSION%>"%OPENCLAW_READY%"

:run
pushd "%OPENCLAW_RUNTIME_DIR%" >nul
"%INSTALL_DIR%node.exe" "dist\index.js" %*
set "OPENCLAW_EXIT_CODE=%ERRORLEVEL%"
popd >nul
exit /b %OPENCLAW_EXIT_CODE%
