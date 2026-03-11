@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "RUNTIME_DIR=%SCRIPT_DIR%runtime"
set "ENTRY=%RUNTIME_DIR%\openclaw.mjs"

if not exist "%ENTRY%" (
  echo [error] missing bundled runtime: %ENTRY% 1>&2
  echo [hint] run deployment\build-local-runtime.ps1 ^(or deployment/build-local-runtime.sh^) 1>&2
  exit /b 1
)

set "RAW_ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "RAW_ARCH=%PROCESSOR_ARCHITEW6432%"

set "ARCH="
if /I "%RAW_ARCH%"=="AMD64" set "ARCH=x86_64"
if /I "%RAW_ARCH%"=="X86_64" set "ARCH=x86_64"
if /I "%RAW_ARCH%"=="ARM64" set "ARCH=arm64"

if "%ARCH%"=="" (
  echo [error] unsupported architecture: %RAW_ARCH% 1>&2
  exit /b 1
)

set "NODE_BIN=%SCRIPT_DIR%node-win-%ARCH%.exe"
if not exist "%NODE_BIN%" (
  echo [error] missing bundled node binary: %NODE_BIN% 1>&2
  echo [hint] place Node 22+ at deployment\bin\node-win-%ARCH%.exe 1>&2
  exit /b 1
)

"%NODE_BIN%" "%ENTRY%" %*
exit /b %ERRORLEVEL%
