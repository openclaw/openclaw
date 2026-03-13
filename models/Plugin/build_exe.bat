@echo off
title Build Robot XML Converter EXE
chcp 65001 >nul
echo ============================================
echo  Build convert_robot_xml.exe (PyInstaller)
echo ============================================
echo.

set SCRIPT_DIR=%~dp0
set TOOLS_DIR=%SCRIPT_DIR%tools
set DIST_DIR=%SCRIPT_DIR%dist

rem Detect Python
set PYTHON=
for %%P in (python python3) do (
    if not defined PYTHON (
        where %%P >nul 2>&1 && set PYTHON=%%P
    )
)
if not defined PYTHON (
    if exist "C:\Python\Python310\python.exe" set PYTHON=C:\Python\Python310\python.exe
)
if not defined PYTHON (
    echo ERROR: Python not found.
    pause & exit /b 1
)

rem Install PyInstaller if missing
%PYTHON% -c "import PyInstaller" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Installing PyInstaller...
    %PYTHON% -m pip install pyinstaller --quiet
)

echo Building single-file EXE...
%PYTHON% -m PyInstaller ^
    --onefile ^
    --console ^
    --name convert_robot_xml ^
    --distpath "%DIST_DIR%" ^
    --workpath "%TEMP%\openclaw_build" ^
    --specpath "%TEMP%\openclaw_build" ^
    --noconfirm ^
    "%TOOLS_DIR%\convert_robot_xml.py"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ============================================
    echo  SUCCESS: %DIST_DIR%\convert_robot_xml.exe
    echo ============================================
    echo.
    echo Usage examples:
    echo   convert_robot_xml.exe --robot-dir "ABB Robot\CRB-15000" --out robots\abb-crb-15000.json --presets --verify
    echo   convert_robot_xml.exe --help
) else (
    echo.
    echo BUILD FAILED. Check output above.
)
echo.
pause
