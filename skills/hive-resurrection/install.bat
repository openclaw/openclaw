@echo off
REM 蜂巢复活系统 - Windows 安装脚本

setlocal enabledelayedexpansion

set NODE_NAME=%1
if "%NODE_NAME%"=="" (
    echo 用法：install.bat ^<节点名^> 例如：install.bat node-a
    exit /b 1
)

set INSTALL_DIR=%CD%\hive-resurrection
set LOG_DIR=%USERPROFILE%\.hive\logs

echo ==========================================
echo   蜂巢复活系统 - Windows 安装
echo   节点名：%NODE_NAME%
echo ==========================================
echo.

REM 检查 Node.js
echo [1/6] 检查 Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo 错误：需要 Node.js >= 18
    echo 安装：https://nodejs.org/
    exit /b 1
)

for /f "tokens=2 delims=v" %%i in ('node -v') do set NODE_VER=%%i
for /f "tokens=1 delims=." %%i in ("!NODE_VER!") do set NODE_MAJOR=%%i

if !NODE_MAJOR! LSS 18 (
    echo 错误：Node.js 版本太低 (当前：!NODE_VER!, 需要：>= 18)
    exit /b 1
)

echo   Node.js: !NODE_VER! [OK]
echo.

REM 创建目录
echo [2/6] 创建目录...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
echo   安装目录：%INSTALL_DIR% [OK]
echo   日志目录：%LOG_DIR% [OK]
echo.

REM 复制文件
echo [3/6] 复制文件...
copy /Y watchdog.js "%INSTALL_DIR%\" >nul
copy /Y monitor.js "%INSTALL_DIR%\" >nul
copy /Y config.example.json "%INSTALL_DIR%\config.json"
echo   文件复制 [OK]
echo.

REM 配置节点名
echo [4/6] 配置节点名...
echo   节点名：%NODE_NAME% [OK]
echo.

REM 创建 Windows 服务
echo [5/6] 创建 Windows 服务...

REM 使用 nssm 创建服务（需要先安装 nssm）
where nssm >nul 2>&1
if errorlevel 1 (
    echo 警告：nssm 未安装，将使用批处理方式运行
    echo 建议安装 nssm: https://nssm.cc/download
    echo.
    echo 手动启动方式:
    echo   cd %INSTALL_DIR%
    echo   node watchdog.js config.json %NODE_NAME%
    echo.
) else (
    nssm install hive-watchdog node "%INSTALL_DIR%\watchdog.js" "%INSTALL_DIR%\config.json" %NODE_NAME%
    nssm set hive-watchdog Start SERVICE_AUTO_START
    nssm set hive-watchdog AppDirectory "%INSTALL_DIR%"
    nssm set hive-watchdog AppStdout "%LOG_DIR%\watchdog.log"
    nssm set hive-watchdog AppStderr "%LOG_DIR%\watchdog.err"
    
    nssm install hive-monitor node "%INSTALL_DIR%\monitor.js" "%INSTALL_DIR%\config.json" %NODE_NAME%
    nssm set hive-monitor Start SERVICE_AUTO_START
    nssm set hive-monitor AppDirectory "%INSTALL_DIR%"
    nssm set hive-monitor AppStdout "%LOG_DIR%\monitor.log"
    nssm set hive-monitor AppStderr "%LOG_DIR%\monitor.err"
    
    echo   Windows 服务创建 [OK]
    echo.
)

REM 启动服务
echo [6/6] 启动服务...
where nssm >nul 2>&1
if not errorlevel 1 (
    nssm start hive-watchdog
    nssm start hive-monitor
    echo   服务已启动
    echo.
)

echo ==========================================
echo   安装完成！
echo ==========================================
echo.
echo 服务状态:
echo   nssm status hive-watchdog
echo   nssm status hive-monitor
echo.
echo 日志查看:
echo   type %LOG_DIR%\watchdog.log
echo   type %LOG_DIR%\monitor.log
echo.
echo 重要：请修改 config.json 中的：
echo   1. 各节点的 host IP 地址
echo   2. secret 密钥 (所有节点必须相同)
echo   3. openclaw 的 workDir 路径
echo.
echo 修改后重启服务:
echo   nssm restart hive-watchdog
echo   nssm restart hive-monitor
echo.
