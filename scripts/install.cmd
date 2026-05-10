@echo off
setlocal enabledelayedexpansion

REM OpenClaw Windows CMD installer
REM Usage:
REM   curl -fsSL https://openclaw.ai/install.cmd -o install.cmd && install.cmd --no-onboard && del install.cmd

set "TAG=latest"
set "INSTALL_METHOD=npm"
set "NO_ONBOARD=0"
set "NO_GIT_UPDATE=0"
set "DRY_RUN=0"
set "TAG_SET=0"
set "INSTALL_PS1_URL="

:parse_args
if "%~1"=="" goto :args_done

if /i "%~1"=="--help" goto :usage
if /i "%~1"=="--git" set "INSTALL_METHOD=git"
if /i "%~1"=="--npm" set "INSTALL_METHOD=npm"
if /i "%~1"=="--no-onboard" set "NO_ONBOARD=1"
if /i "%~1"=="--no-git-update" set "NO_GIT_UPDATE=1"
if /i "%~1"=="--dry-run" set "DRY_RUN=1"

if /i "%~1"=="--tag" (
  if not "%~2"=="" (
    set "TAG=%~2"
    set "TAG_SET=1"
    shift
  )
  shift
  goto :parse_args
)

set "ARG=%~1"
if not "%ARG%"=="" (
  if not "%ARG:~0,1%"=="-" (
    if "%TAG_SET%"=="0" (
      set "TAG=%ARG%"
      set "TAG_SET=1"
    )
  )
)

shift
goto :parse_args

:args_done

curl --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo curl is required but not available. Please install curl or use PowerShell installer. >&2
  exit /b 1
)

powershell -NoProfile -Command "$PSVersionTable.PSVersion.Major" >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo PowerShell is required but not available. Use install.ps1 directly or install PowerShell. >&2
  exit /b 1
)

set "TMP=%TEMP%\openclaw-install.ps1"
REM TMP may include spaces; always quote "%TMP%" when used.
if not "%OPENCLAW_INSTALL_PS1_URL%"=="" set "INSTALL_PS1_URL=%OPENCLAW_INSTALL_PS1_URL%"
if "%INSTALL_PS1_URL%"=="" set "INSTALL_PS1_URL=https://openclaw.ai/install.ps1"

if exist "%INSTALL_PS1_URL%" (
  copy /Y "%INSTALL_PS1_URL%" "%TMP%" >nul
) else (
  curl -fsSL "%INSTALL_PS1_URL%" -o "%TMP%"
)
if %ERRORLEVEL% neq 0 (
  echo Failed to download install.ps1 >&2
  exit /b 1
)

set "PS_ARGS=-Tag ""%TAG%"" -InstallMethod ""%INSTALL_METHOD%"""
if "%NO_ONBOARD%"=="1" set "PS_ARGS=%PS_ARGS% -NoOnboard"
if "%NO_GIT_UPDATE%"=="1" set "PS_ARGS=%PS_ARGS% -NoGitUpdate"
if "%DRY_RUN%"=="1" set "PS_ARGS=%PS_ARGS% -DryRun"

if "%DRY_RUN%"=="1" echo [OK] Dry run ^(delegating to install.ps1^)
powershell -NoProfile -ExecutionPolicy Bypass -File "%TMP%" %PS_ARGS%
set "RESULT=%ERRORLEVEL%"

del /f "%TMP%" >nul 2>&1

if %RESULT% neq 0 exit /b %RESULT%
exit /b 0

:usage
echo Usage: install.cmd [options] [tag]
echo.
echo Options:
echo   --git             Install from git checkout
echo   --npm             Install via npm ^(default^)
echo   --tag <ver>       Tag/version to install ^(default: latest^)
echo   --no-onboard      Skip onboarding
echo   --no-git-update   Skip git pull for existing checkout
echo   --dry-run         Print what would happen ^(no changes^)
exit /b 0
