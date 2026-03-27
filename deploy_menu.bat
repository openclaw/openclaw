@echo off
set "PATH=%PATH%;C:\Program Files\Git\bin"
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

title OpenClaw Deploy Helper

set "SOURCE_DIR=%~dp0"
if "%SOURCE_DIR:~-1%"=="\" set "SOURCE_DIR=%SOURCE_DIR:~0,-1%"
if defined OPENCLAW_DEPLOY_DIR (
  set "DEPLOY_DIR=%OPENCLAW_DEPLOY_DIR%"
) else (
  set "DEPLOY_DIR=D:\OpenClaw\deploy"
)
set "RUNTIME_DIR=%DEPLOY_DIR%\openclaw-runtime-next"
set "PACKAGE_DIR=%RUNTIME_DIR%\package"
set "LEGACY_RUNTIME_DIR=%DEPLOY_DIR%\openclaw-runtime-live"
set "LEGACY_PACKAGE_DIR=%LEGACY_RUNTIME_DIR%\package"
set "BACKUP_DIR=%DEPLOY_DIR%\_persist_backup"
set "PORT=18789"
set "BRIDGE_PORT=9877"
set "LOG_FILE=%DEPLOY_DIR%\gateway.log"
set "ENSURE_SCRIPT=%SOURCE_DIR%\scripts\ensure-deploy-runtime.ps1"
set "POST_VERIFY_SCRIPT=%SOURCE_DIR%\deploy-post-release\verify_post_release.ps1"

rem Numeric argument mode
if "%~1"=="1" goto do_compile_once
if "%~1"=="2" goto do_publish_once
if "%~1"=="3" goto do_restart_once
if "%~1"=="4" goto do_all_once
if "%~1"=="5" goto do_skills_once
if "%~1"=="6" goto do_status_once
if "%~1"=="7" goto do_start_dir_once
if "%~1"=="8" goto do_stop_dir_once
if "%~1"=="9" goto do_logs_once
if "%~1"=="10" goto do_verify_once
if "%~1"=="0" goto done

rem Keyword argument mode
if /I "%~1"=="compile" goto do_compile_once
if /I "%~1"=="build-docker" goto do_build_docker_once
if /I "%~1"=="publish" goto do_publish_once
if /I "%~1"=="restart" goto do_restart_once
if /I "%~1"=="all" goto do_all_once
if /I "%~1"=="skills" goto do_skills_once
if /I "%~1"=="status" goto do_status_once
if /I "%~1"=="start" goto do_start_dir_once
if /I "%~1"=="stop" goto do_stop_dir_once
if /I "%~1"=="logs" goto do_logs_once
if /I "%~1"=="verify" goto do_verify_once
if /I "%~1"=="release-verify" goto do_release_verify_once

:menu
cls
echo ==============================================================
echo   OpenClaw One-Click Deploy Helper
echo.
echo   Source : %SOURCE_DIR%
echo   Deploy : %DEPLOY_DIR%
echo   Port   : %PORT%
echo ==============================================================
echo [1] Compile project (install + ui:build)
echo [B] Build docker (build:docker)
echo [2] Publish and update deploy directory (keep memory/skills/MCP data)
echo [3] Restart service and verify access
echo [4] Run full flow (1 + B + 2 + 3)
echo [5] Search/Install/Update skills (ClawHub)
echo [6] Show running OpenClaw services and status
echo [7] Start OpenClaw service from a specified directory
echo [8] Stop OpenClaw service from a specified directory
echo [9] Show deploy gateway log tail
echo [V] Verify post-release runtime health
echo [R] Publish + Restart + Verify (recommended)
echo [K] Kill node process
echo [0] Exit
set "CHOICE="
set /p "CHOICE=Select [0-9, B, V, R, K]: " || goto done
if not defined CHOICE goto done

if "%CHOICE%"=="1" goto do_compile
if /I "%CHOICE%"=="B" goto do_build_docker
if "%CHOICE%"=="2" goto do_publish
if "%CHOICE%"=="3" goto do_restart
if "%CHOICE%"=="4" goto do_all
if "%CHOICE%"=="5" goto do_skills
if "%CHOICE%"=="6" goto do_status
if "%CHOICE%"=="7" goto do_start_dir
if "%CHOICE%"=="8" goto do_stop_dir
if "%CHOICE%"=="9" goto do_logs
if /I "%CHOICE%"=="V" goto do_verify
if /I "%CHOICE%"=="R" goto do_release_verify
if /I "%CHOICE%"=="K" goto do_kill_node
if "%CHOICE%"=="0" goto done

echo.
echo [WARN] Invalid input. Please enter 0-9, B, V, R, or K.
pause
goto menu

:do_release_verify
taskkill /F /IM node.exe
echo Kill node process done
goto menu

:do_release_verify
call :banner "Publish + Restart + Verify"
call :publish_update
if errorlevel 1 goto show_result
call :restart_service
if errorlevel 1 goto show_result
call :verify_post_release
call :show_result
goto menu

:do_release_verify_once
call :banner "Publish + Restart + Verify"
call :publish_update
if errorlevel 1 exit /b 1
call :restart_service
if errorlevel 1 exit /b 1
call :verify_post_release
if errorlevel 1 exit /b 1
exit /b 0

:do_compile
call :banner "Compile project"
call :compile_project
call :show_result
goto menu

:do_compile_once
call :banner "Compile project"
call :compile_project
if errorlevel 1 exit /b 1
exit /b 0

:do_build_docker
call :banner "Build docker"
call :build_docker_project
call :show_result
goto menu

:do_build_docker_once
call :banner "Build docker"
call :build_docker_project
if errorlevel 1 exit /b 1
exit /b 0

:do_publish
call :banner "Publish and update deploy directory"
call :publish_update
call :show_result
goto menu

:do_publish_once
call :banner "Publish and update deploy directory"
call :publish_update
if errorlevel 1 exit /b 1
exit /b 0

:do_restart
call :banner "Restart service"
call :restart_service
call :show_result
goto menu

:do_restart_once
call :banner "Restart service"
call :restart_service
if errorlevel 1 exit /b 1
exit /b 0

:do_all
call :banner "Run full flow"
call :compile_project
if errorlevel 1 goto show_result
call :build_docker_project
if errorlevel 1 goto show_result
call :publish_update
if errorlevel 1 goto show_result
call :restart_service
call :show_result
goto menu

:do_all_once
call :banner "Run full flow"
call :compile_project
if errorlevel 1 exit /b 1
call :build_docker_project
if errorlevel 1 exit /b 1
call :publish_update
if errorlevel 1 exit /b 1
call :restart_service
if errorlevel 1 exit /b 1
exit /b 0

:do_skills
call :banner "Skills management"
call :skills_menu
call :show_result
goto menu

:do_skills_once
call :banner "Skills management"
call :skills_menu
if errorlevel 1 exit /b 1
exit /b 0

:do_status
call :banner "Service status overview"
call :show_service_status
call :show_result
goto menu

:do_status_once
call :banner "Service status overview"
call :show_service_status
if errorlevel 1 exit /b 1
exit /b 0

:do_start_dir
call :banner "Start service from specified directory"
set "TARGET_DIR="
set /p "TARGET_DIR=Enter package directory path: " || goto menu
if not defined TARGET_DIR goto menu
set "TARGET_PORT="
set /p "TARGET_PORT=Enter port (default %PORT%): "
if not defined TARGET_PORT set "TARGET_PORT=%PORT%"
call :start_service_in_dir "%TARGET_DIR%" "%TARGET_PORT%"
call :show_result
goto menu

:do_start_dir_once
set "TARGET_DIR=%~2"
set "TARGET_PORT=%~3"
if not defined TARGET_DIR set "TARGET_DIR=%PACKAGE_DIR%"
if not defined TARGET_PORT set "TARGET_PORT=%PORT%"
call :banner "Start service from specified directory"
call :start_service_in_dir "%TARGET_DIR%" "%TARGET_PORT%"
if errorlevel 1 exit /b 1
exit /b 0

:do_stop_dir
call :banner "Stop service from specified directory"
set "TARGET_DIR="
set /p "TARGET_DIR=Enter package directory path: " || goto menu
if not defined TARGET_DIR goto menu
call :stop_service_in_dir "%TARGET_DIR%"
call :show_result
goto menu

:do_stop_dir_once
set "TARGET_DIR=%~2"
if not defined TARGET_DIR set "TARGET_DIR=%PACKAGE_DIR%"
call :banner "Stop service from specified directory"
call :stop_service_in_dir "%TARGET_DIR%"
if errorlevel 1 exit /b 1
exit /b 0

:do_logs
call :banner "Deploy gateway log tail"
call :show_gateway_log_tail
call :show_result
goto menu

:do_logs_once
call :banner "Deploy gateway log tail"
call :show_gateway_log_tail
if errorlevel 1 exit /b 1
exit /b 0

:do_verify
call :banner "Verify post-release runtime health"
call :verify_post_release
call :show_result
goto menu

:do_verify_once
call :banner "Verify post-release runtime health"
call :verify_post_release
if errorlevel 1 exit /b 1
exit /b 0

:compile_project
call :step "Switch to source directory"
pushd "%SOURCE_DIR%" || (echo [ERROR] Cannot enter source directory: %SOURCE_DIR% & exit /b 1)

call :step "Install dependencies: pnpm install"
call pnpm install
if errorlevel 1 (echo [ERROR] pnpm install failed. & exit /b 1)

call :step "Build UI: pnpm ui:build"
call pnpm ui:build
if errorlevel 1 (echo [ERROR] pnpm ui:build failed. & exit /b 1)

echo [OK] Compile completed.
exit /b 0

:build_docker_project
call :step "Switch to source directory"
pushd "%SOURCE_DIR%" || (echo [ERROR] Cannot enter source directory: %SOURCE_DIR% & exit /b 1)

call :step "Build runtime: pnpm build:docker"
call pnpm build:docker
if errorlevel 1 (echo [ERROR] pnpm build:docker failed. & exit /b 1)

echo [OK] Docker build completed.
exit /b 0

:publish_update
call :step "Create deploy directory if missing"
if not exist "%DEPLOY_DIR%" mkdir "%DEPLOY_DIR%"
if errorlevel 1 (echo [ERROR] Cannot create deploy directory: %DEPLOY_DIR% & exit /b 1)

call :step "Stop existing service and release port"
if exist "%PACKAGE_DIR%\openclaw.mjs" (
    pushd "%PACKAGE_DIR%"
    call node openclaw.mjs gateway stop >nul 2>nul
    popd
  )
call :stop_gateway_processes
set "PID="
for /f "delims=" %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue ^| Select-Object -First 1 -ExpandProperty OwningProcess)"') do set "PID=%%P"
if defined PID (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Id %PID% -Force" >nul 2>nul
  ping 127.0.0.1 -n 2 >nul
)
call :wait_runtime_release
if errorlevel 1 (
  echo [ERROR] Runtime processes did not stop cleanly. Abort publish.
  exit /b 1
)

call :step "Create tgz package in deploy directory"
  pushd "%SOURCE_DIR%"
  call pnpm pack --pack-destination "%DEPLOY_DIR%" --config.ignore-scripts=true
  popd
  if errorlevel 1 (echo [ERROR] Package creation failed. & exit /b 1)

set "TGZ_FILE="
for /f "delims=" %%F in ('dir /b /a-d /o-d "%DEPLOY_DIR%\openclaw-*.tgz" 2^>nul') do if not defined TGZ_FILE set "TGZ_FILE=%%F"
if not defined TGZ_FILE (
  echo [ERROR] Package not found: %DEPLOY_DIR%\openclaw-*.tgz
  exit /b 1
)
call :step "Detected package: %TGZ_FILE%"

call :step "Backup persistent data"
if exist "%BACKUP_DIR%" rmdir /s /q "%BACKUP_DIR%"
mkdir "%BACKUP_DIR%"
if errorlevel 1 (echo [ERROR] Cannot create backup directory: %BACKUP_DIR% & exit /b 1)

if exist "%PACKAGE_DIR%" (
  call :backup_one "workspace"
  call :backup_one "skills"
  call :backup_one ".clawhub"
  call :backup_one "data"
  call :backup_one "storage"
  call :backup_one "user-data"
  call :backup_one "extensions\managed"
  call :backup_one "extensions\custom"
)

if not exist "%PACKAGE_DIR%" if exist "%LEGACY_PACKAGE_DIR%" (
  call :step "Migrate persistent data from legacy runtime"
  call :backup_legacy_one "workspace"
  call :backup_legacy_one "skills"
  call :backup_legacy_one ".clawhub"
  call :backup_legacy_one "data"
  call :backup_legacy_one "storage"
  call :backup_legacy_one "user-data"
  call :backup_legacy_one "extensions\managed"
  call :backup_legacy_one "extensions\custom"
)

call :step "Replace runtime directory"
call :wait_runtime_release
if errorlevel 1 (
  echo [ERROR] Runtime processes still active before directory replacement.
  exit /b 1
)
call :assert_runtime_writable
if errorlevel 1 exit /b 1
if exist "%RUNTIME_DIR%" (
  call :stop_runtime_lockers
  rmdir /s /q "%RUNTIME_DIR%"
)
if exist "%RUNTIME_DIR%" (
  call :step "Retry cleanup runtime directory"
  ping 127.0.0.1 -n 2 >nul
  call :stop_runtime_lockers
  rmdir /s /q "%RUNTIME_DIR%"
)
if exist "%RUNTIME_DIR%" (
  echo [WARN] Cannot fully clean runtime directory ^(maybe locked^): %RUNTIME_DIR%
  echo [INFO] Continue with in-place runtime update.
)
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
if errorlevel 1 (echo [ERROR] Cannot create runtime directory: %RUNTIME_DIR% & exit /b 1)

call :step "Extract package to runtime directory"
tar -xf "%DEPLOY_DIR%\%TGZ_FILE%" -C "%RUNTIME_DIR%"
if errorlevel 1 (echo [ERROR] Package extraction failed. & exit /b 1)
if not exist "%PACKAGE_DIR%\openclaw.mjs" (
  echo [ERROR] Missing key file after extraction: %PACKAGE_DIR%\openclaw.mjs
  exit /b 1
)

call :step "Install runtime dependencies: pnpm install --prod"
  pushd "%PACKAGE_DIR%" || (echo [ERROR] Runtime package directory not found: %PACKAGE_DIR% & exit /b 1)
  call pnpm install --prod
  popd
  if errorlevel 1 (echo [ERROR] Runtime dependency install failed. & exit /b 1)

call :step "Sync built runtime dist"
if not exist "%SOURCE_DIR%\dist\entry.mjs" if not exist "%SOURCE_DIR%\dist\entry.js" (
  echo [ERROR] Source dist entry file is missing. Run compile first.
  exit /b 1
)
if not exist "%PACKAGE_DIR%\dist" mkdir "%PACKAGE_DIR%\dist"
xcopy "%SOURCE_DIR%\dist\*" "%PACKAGE_DIR%\dist\" /E /I /Y >nul
if errorlevel 1 (echo [ERROR] Sync dist failed. & exit /b 1)

call :step "Sync Control UI assets"
set "CONTROL_UI_SOURCE_DIR="
if exist "%SOURCE_DIR%\dist\control-ui\index.html" set "CONTROL_UI_SOURCE_DIR=%SOURCE_DIR%\dist\control-ui"
if not defined CONTROL_UI_SOURCE_DIR if exist "%SOURCE_DIR%\extensions\googlechat\node_modules\openclaw\dist\control-ui\index.html" set "CONTROL_UI_SOURCE_DIR=%SOURCE_DIR%\extensions\googlechat\node_modules\openclaw\dist\control-ui"
if not defined CONTROL_UI_SOURCE_DIR if exist "%SOURCE_DIR%\node_modules\openclaw\dist\control-ui\index.html" set "CONTROL_UI_SOURCE_DIR=%SOURCE_DIR%\node_modules\openclaw\dist\control-ui"

if defined CONTROL_UI_SOURCE_DIR (
  if not exist "%PACKAGE_DIR%\dist\control-ui" mkdir "%PACKAGE_DIR%\dist\control-ui"
  xcopy "%CONTROL_UI_SOURCE_DIR%\*" "%PACKAGE_DIR%\dist\control-ui\" /E /I /Y >nul
  if errorlevel 1 (echo [ERROR] Sync Control UI failed. & exit /b 1)
) else (
  echo [INFO] No Control UI source detected. Keep package-bundled assets.
)

call :step "Restore persistent data"
call :restore_one "workspace"
call :restore_one "skills"
call :restore_one ".clawhub"
call :restore_one "data"
call :restore_one "storage"
call :restore_one "user-data"
call :restore_one "extensions\managed"
call :restore_one "extensions\custom"

call :step "Ensure runtime config and required plugins"
call :ensure_runtime_assets
if errorlevel 1 (echo [ERROR] Runtime ensure step failed. & exit /b 1)

if exist "%BACKUP_DIR%" rmdir /s /q "%BACKUP_DIR%"

echo [OK] Deploy directory updated successfully.
echo [INFO] User folder %USERPROFILE%\.openclaw is not removed.
exit /b 0

:restart_service
if not exist "%PACKAGE_DIR%\openclaw.mjs" (
  echo [ERROR] Runtime package is missing. Run publish first.
  exit /b 1
)
call :step "Try graceful gateway stop"
pushd "%PACKAGE_DIR%"
call :stop_gateway_processes
popd
call :step "Stop scheduled gateway supervisor if present"
schtasks /End /TN "OpenClaw Gateway" >nul 2>nul
ping 127.0.0.1 -n 2 >nul
call :step "Release port %PORT% if occupied"
for /f "delims=" %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue ^| Select-Object -ExpandProperty OwningProcess -Unique)"') do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Id %%P -Force" >nul 2>nul
)
call :wait_port_free %PORT%
if errorlevel 1 (
  echo [ERROR] Port %PORT% is still occupied after stop.
  exit /b 1
)

call :step "Release bridge port %BRIDGE_PORT% if occupied"
for /f "delims=" %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-NetTCPConnection -LocalPort %BRIDGE_PORT% -State Listen -ErrorAction SilentlyContinue ^| Select-Object -ExpandProperty OwningProcess -Unique)"') do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Id %%P -Force" >nul 2>nul
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'ws-bridge\.ts' -or $_.CommandLine -match 'mock_virtual_bridge\.mjs' }; foreach($p in $procs){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }" >nul 2>nul
call :wait_port_free %BRIDGE_PORT%
if errorlevel 1 (
  echo [WARN] Bridge port %BRIDGE_PORT% is still occupied. Gateway may fail if ABB bridge plugin auto-starts.
)

call :step "Rotate gateway log"
if exist "%LOG_FILE%" copy /y "%LOG_FILE%" "%DEPLOY_DIR%\gateway.previous.log" >nul 2>nul
type nul > "%LOG_FILE%"

call :step "Start gateway in background"
call :ensure_runtime_assets
if errorlevel 1 (echo [ERROR] Runtime ensure step failed. & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:OPENCLAW_CONFIG_PATH='%DEPLOY_DIR%\config.runtime.json'; Start-Process -FilePath 'node' -ArgumentList @('openclaw.mjs','gateway','run','--port','%PORT%') -WorkingDirectory '%PACKAGE_DIR%' -WindowStyle Minimized -RedirectStandardOutput '%LOG_FILE%' -RedirectStandardError '%DEPLOY_DIR%\gateway.err.log'" >nul 2>nul

call :step "Wait for startup and stability check"
call :wait_gateway_stable %PORT% 60
if errorlevel 1 (
  echo [WARN] Service failed startup/stability check. Check log: %LOG_FILE%
  exit /b 1
)

echo [OK] Service restarted. URL: http://127.0.0.1:%PORT%
exit /b 0

:skills_menu
where clawhub >nul 2>nul
if errorlevel 1 (
  echo [WARN] clawhub CLI not found.
  echo [INFO] Install first: npm i -g clawhub  or  pnpm add -g clawhub
  exit /b 1
)

cd /d "%PACKAGE_DIR%" 2>nul
if errorlevel 1 cd /d "%SOURCE_DIR%"

echo.
echo [1] Search skills
echo [2] Install one skill
echo [3] Update all installed skills
set "SK="
set /p "SK=Select [1-3]: " || exit /b 1
if not defined SK exit /b 1

if "%SK%"=="1" (
  set "Q="
  set /p "Q=Enter search keyword: " || exit /b 1
  if "%Q%"=="" (echo [WARN] Keyword cannot be empty. & exit /b 1)
  call clawhub search "%Q%"
  if errorlevel 1 exit /b 1
  exit /b 0
)

if "%SK%"=="2" (
  set "SLUG="
  set /p "SLUG=Enter skill slug: " || exit /b 1
  if "%SLUG%"=="" (echo [WARN] Slug cannot be empty. & exit /b 1)
  call clawhub install "%SLUG%"
  if errorlevel 1 exit /b 1
  echo [INFO] Restart gateway after install to load the skill.
  exit /b 0
)

if "%SK%"=="3" (
  call clawhub update --all
  if errorlevel 1 exit /b 1
  echo [INFO] Restart gateway after update.
  exit /b 0
)

echo [WARN] Invalid input.
exit /b 1

:show_service_status
echo [INFO] Known deploy package directories:
call :print_dir_status "%DEPLOY_DIR%\openclaw-runtime-next\package"
call :print_dir_status "%DEPLOY_DIR%\openclaw-runtime-live\package"
call :print_dir_status "%DEPLOY_DIR%\openclaw-runtime\package"
echo.
echo [INFO] Running OpenClaw gateway processes:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'openclaw\.mjs\s+gateway' }; if($procs){ $procs | Select-Object ProcessId,CommandLine | Format-Table -AutoSize } else { Write-Host 'No running gateway process found.' }"
echo.
echo [INFO] Default port health (%PORT%):
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%PORT%' -TimeoutSec 8; Write-Host ('HTTP=' + $r.StatusCode) } catch { Write-Host ('HTTP_ERROR=' + $_.Exception.Message) }"
exit /b 0

:print_dir_status
set "CHECK_DIR=%~1"
if exist "%CHECK_DIR%\openclaw.mjs" (
  echo   [FOUND] %CHECK_DIR%
) else (
  echo   [MISSING] %CHECK_DIR%
)
exit /b 0

:start_service_in_dir
set "TARGET_DIR=%~1"
set "TARGET_PORT=%~2"
if not exist "%TARGET_DIR%\openclaw.mjs" (
  echo [ERROR] openclaw.mjs not found in: %TARGET_DIR%
  exit /b 1
)
if "%TARGET_PORT%"=="" set "TARGET_PORT=%PORT%"

call :step "Stop existing listener on target port"
set "PID="
for /f "delims=" %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-NetTCPConnection -LocalPort %TARGET_PORT% -State Listen -ErrorAction SilentlyContinue ^| Select-Object -First 1 -ExpandProperty OwningProcess)"') do set "PID=%%P"
if defined PID powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Id %PID% -Force" >nul 2>nul

call :step "Start gateway from target directory"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'node' -ArgumentList @('openclaw.mjs','gateway','run','--port','%TARGET_PORT%','--verbose') -WorkingDirectory '%TARGET_DIR%' -WindowStyle Minimized -RedirectStandardOutput '%DEPLOY_DIR%\gateway-%TARGET_PORT%.log' -RedirectStandardError '%DEPLOY_DIR%\gateway-%TARGET_PORT%.err.log'" >nul 2>nul

call :step "Health check"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 8; try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:%TARGET_PORT%' -UseBasicParsing -TimeoutSec 15; if($r.StatusCode -eq 200){ exit 0 } else { exit 2 } } catch { exit 1 }"
if errorlevel 1 (
  echo [WARN] Service may not be fully started on port %TARGET_PORT%.
  echo [INFO] Check log: %DEPLOY_DIR%\gateway-%TARGET_PORT%.log
  exit /b 1
)

echo [OK] Service started from: %TARGET_DIR%
echo [OK] URL: http://127.0.0.1:%TARGET_PORT%
exit /b 0

:stop_service_in_dir
set "TARGET_DIR=%~1"
if not exist "%TARGET_DIR%\openclaw.mjs" (
  echo [ERROR] openclaw.mjs not found in: %TARGET_DIR%
  exit /b 1
)

call :step "Graceful stop"
  pushd "%TARGET_DIR%"
  call node openclaw.mjs gateway stop >nul 2>nul
  popd

call :step "Force-stop remaining gateway processes for target directory"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$target=[regex]::Escape('%TARGET_DIR%'); $procs = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'openclaw\.mjs\s+gateway' -and $_.CommandLine -match $target }; foreach($p in $procs){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }"

echo [OK] Stop command executed for: %TARGET_DIR%
exit /b 0

:show_gateway_log_tail
if not exist "%LOG_FILE%" (
  echo [WARN] Log file not found: %LOG_FILE%
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Path '%LOG_FILE%' -Tail 80"
exit /b 0

:backup_one
set "REL=%~1"
if exist "%PACKAGE_DIR%\%REL%" (
  mkdir "%BACKUP_DIR%\%REL%" 2>nul
  xcopy "%PACKAGE_DIR%\%REL%\*" "%BACKUP_DIR%\%REL%\" /E /I /Y >nul
)
exit /b 0

:backup_legacy_one
set "REL=%~1"
if exist "%LEGACY_PACKAGE_DIR%\%REL%" (
  mkdir "%BACKUP_DIR%\%REL%" 2>nul
  xcopy "%LEGACY_PACKAGE_DIR%\%REL%\*" "%BACKUP_DIR%\%REL%\" /E /I /Y >nul
)
exit /b 0

:restore_one
set "REL=%~1"
if exist "%BACKUP_DIR%\%REL%" (
  if not exist "%PACKAGE_DIR%\%REL%" mkdir "%PACKAGE_DIR%\%REL%" 2>nul
  xcopy "%BACKUP_DIR%\%REL%\*" "%PACKAGE_DIR%\%REL%\" /E /I /Y >nul
)
exit /b 0

:stop_gateway_processes
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'openclaw\.mjs\s+gateway' -or $_.CommandLine -match 'dist\\index\.js\s+gateway' -or $_.CommandLine -match 'openclaw-runtime-next\\package\\openclaw\.mjs' -or $_.CommandLine -match 'openclaw-runtime-live\\package\\openclaw\.mjs' -or $_.CommandLine -match 'openclaw-runtime\\package\\openclaw\.mjs' }; foreach($p in $procs){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }" >nul 2>nul
ping 127.0.0.1 -n 2 >nul
exit /b 0

:wait_runtime_release
call :stop_runtime_lockers
call :wait_port_free %PORT%
if errorlevel 1 exit /b 1
exit /b 0

:wait_port_free
set "WAIT_PORT=%~1"
if "%WAIT_PORT%"=="" set "WAIT_PORT=%PORT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=%WAIT_PORT%; $deadline=(Get-Date).AddSeconds(30); while((Get-Date)-lt $deadline){ $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if(-not $c){ exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1" >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:wait_gateway_stable
set "WG_PORT=%~1"
set "WG_SECS=%~2"
if "%WG_PORT%"=="" set "WG_PORT=%PORT%"
if "%WG_SECS%"=="" set "WG_SECS=60"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port=%WG_PORT%; $secs=%WG_SECS%; if($secs -le 0){ $secs=60 }; $startupDeadline=(Get-Date).AddSeconds(25); $started=$false; while((Get-Date)-lt $startupDeadline){ try { $r=Invoke-WebRequest -Uri ('http://127.0.0.1:{0}' -f $port) -UseBasicParsing -TimeoutSec 6; if($r.StatusCode -eq 200){ $started=$true; break } } catch {}; Start-Sleep -Seconds 2 }; if(-not $started){ exit 1 }; $stableDeadline=(Get-Date).AddSeconds($secs); while((Get-Date)-lt $stableDeadline){ $proc=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'openclaw\.mjs\s+gateway\s+run' -or $_.CommandLine -match 'dist\\index\.js\s+gateway' }; if(-not $proc){ exit 1 }; try { $r=Invoke-WebRequest -Uri ('http://127.0.0.1:{0}' -f $port) -UseBasicParsing -TimeoutSec 6; if($r.StatusCode -ne 200){ exit 1 } } catch { exit 1 }; Start-Sleep -Seconds 5 }; exit 0" >nul 2>nul 
if errorlevel 1 exit /b 1
exit /b 0

:stop_runtime_lockers
powershell -NoProfile -ExecutionPolicy Bypass -Command "$target=[regex]::Escape('%RUNTIME_DIR%'); $procs=Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','cmd.exe','npm.exe','pnpm.exe') -and $_.CommandLine -match $target }; foreach($p in $procs){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }" >nul 2>nul
ping 127.0.0.1 -n 2 >nul
exit /b 0

:assert_runtime_writable
if not exist "%RUNTIME_DIR%" exit /b 0
set "WRITE_TEST_FILE=%RUNTIME_DIR%\.__openclaw_write_test__"
del /f /q "%WRITE_TEST_FILE%" >nul 2>nul
echo ok>"%WRITE_TEST_FILE%" 2>nul
if errorlevel 1 (
  echo [ERROR] Runtime directory is not writable: %RUNTIME_DIR%
  echo [INFO] Close any terminals/processes using this path and rerun.
  echo [INFO] If denied persists, run elevated command:
  echo [INFO]   icacls "%RUNTIME_DIR%" /grant *S-1-1-0:^(OI^)^(CI^)F /T /C
  exit /b 1
)
del /f /q "%WRITE_TEST_FILE%" >nul 2>nul

if exist "%RUNTIME_DIR%\package\dist" (
  set "WRITE_TEST_FILE=%RUNTIME_DIR%\package\dist\.__openclaw_write_test__"
  del /f /q "%WRITE_TEST_FILE%" >nul 2>nul
  echo ok>"%WRITE_TEST_FILE%" 2>nul
  if errorlevel 1 (
    echo [ERROR] Runtime dist directory is not writable: %RUNTIME_DIR%\package\dist
    echo [INFO] Close any terminals/processes using this path and rerun.
    echo [INFO] If denied persists, run elevated commands:
    echo [INFO]   icacls "%RUNTIME_DIR%\package\dist" /grant *S-1-1-0:^(OI^)^(CI^)F /T /C
    echo [INFO]   attrib -R "%RUNTIME_DIR%\package\dist\*" /S /D
    exit /b 1
  )
  del /f /q "%WRITE_TEST_FILE%" >nul 2>nul
)
exit /b 0

:ensure_runtime_assets
if not exist "%ENSURE_SCRIPT%" (
  echo [WARN] Ensure script not found: %ENSURE_SCRIPT%
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%ENSURE_SCRIPT%" -DeployDir "%DEPLOY_DIR%" -SourceDir "%SOURCE_DIR%"
if errorlevel 1 exit /b 1
exit /b 0

:verify_post_release
if not exist "%POST_VERIFY_SCRIPT%" (
  echo [WARN] Post-release verify script not found: %POST_VERIFY_SCRIPT%
  echo [INFO] Skipping post-release verification.
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%POST_VERIFY_SCRIPT%" -ProjectDir "%SOURCE_DIR%" -DeployDir "%DEPLOY_DIR%" -Port %PORT%
if errorlevel 1 exit /b 1
exit /b 0

:update_skills_safely
where clawhub >nul 2>nul
if errorlevel 1 (
  echo [INFO] clawhub not installed. Skip skills auto-update.
  exit /b 0
)
if not exist "%PACKAGE_DIR%\openclaw.mjs" (
  echo [INFO] Runtime package not ready. Skip skills auto-update.
  exit /b 0
)
  pushd "%PACKAGE_DIR%"
  call clawhub update --all >nul 2>nul
  popd
if errorlevel 1 (
  echo [WARN] clawhub update failed. Continue deploy.
  exit /b 0
)
echo [OK] clawhub skills updated.
exit /b 0

:banner
echo.
echo ==============================================================
echo   %~1
echo ==============================================================
exit /b 0

:step
echo [RUN] %~1
exit /b 0

:show_result
if errorlevel 1 (
  echo.
  echo [RESULT] Failed. Check messages above and retry.
) else (
  echo.
  echo [RESULT] Success.
)
pause
exit /b 0

:done
echo Exit deploy helper.
endlocal
exit /b 0
