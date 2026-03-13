@echo off
title OpenClaw Robot XML Converter
chcp 65001 >nul
echo ============================================
echo  OpenClaw Robot XML to JSON Converter
echo ============================================
echo.

set SCRIPT_DIR=%~dp0
set TOOLS_DIR=%SCRIPT_DIR%tools
set ROBOTS_DIR=%SCRIPT_DIR%robots

rem Auto-detect Python
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
    echo ERROR: Python not found. Please install Python 3.8+ from https://python.org
    pause
    exit /b 1
)
echo Using Python: %PYTHON%
echo.

rem Find all robot directories under ABB Robot
set ABB_DIR=%SCRIPT_DIR%..\ABB Robot
echo Scanning for robot configurations in: %ABB_DIR%
echo.

set FOUND=0
for /d %%R in ("%ABB_DIR%\*") do (
    set ROBOT_NAME=%%~nxR
    rem Check for rlkin and rlmdl subdirs
    if exist "%%R\rlkin" if exist "%%R\rlmdl" (
        echo Found robot: %%~nxR
        rem Generate robot-id: lowercase, spaces to dashes, prefix with manufacturer if needed
        for /f "delims=" %%I in ('echo %%~nxR') do (
            set RAW_ID=%%I
        )
        rem Use Python to generate safe robot-id
        for /f %%O in ('%PYTHON% -c "import re,sys; n=sys.argv[1]; print(re.sub(chr(39)+chr(32)+chr(43)+chr(39),-'+',n).lower().replace(chr(32),chr(45))[:64])" "%%~nxR" 2^>nul') do set ROBOT_ID=%%O
        if not defined ROBOT_ID set ROBOT_ID=%%~nxR
        set ROBOT_ID=!ROBOT_ID: =-!
        
        rem Find GLB file in ABB Robot dir
        set GLB_ARG=
        for %%G in ("%ABB_DIR%\%%~nxR*.glb" "%ABB_DIR%\*.glb") do (
            if exist "%%G" if not defined GLB_ARG set GLB_ARG=%%~nxG
        )
        
        set OUT=%ROBOTS_DIR%\%%~nxR
        rem Normalize name to kebab-case for output filename
        echo   Converting %%~nxR ...
        
        %PYTHON% "%TOOLS_DIR%\convert_robot_xml.py" ^
            --robot-dir "%%R" ^
            --out "%ROBOTS_DIR%\%%~nxR.json" ^
            --robot-id "%%~nxR" ^
            --presets --verify
        
        if %ERRORLEVEL% EQU 0 (
            echo   [OK] Generated: %ROBOTS_DIR%\%%~nxR.json
        ) else (
            echo   [FAIL] Conversion failed for %%~nxR
        )
        echo.
        set /a FOUND+=1
    )
)

if %FOUND% EQU 0 (
    echo No robot configurations found.
    echo Expected structure: "ABB Robot\RobotName\rlkin\*.xml" and "ABB Robot\RobotName\rlmdl\*.xml"
)
echo.
echo Done. Press any key to exit.
pause
