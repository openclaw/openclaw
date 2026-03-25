@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

title ABBBridge Unified Compiler

set "SOURCE_DIR=%~dp0"
set "CS_FILE=%SOURCE_DIR%ABBBridge.cs"
set "OUTPUT_DLL=%SOURCE_DIR%ABBBridge.dll"

echo.
echo ============================================================
echo   ABBBridge Unified Compiler
echo ============================================================
echo.

if not exist "!CS_FILE!" (
  echo [ERROR] ABBBridge.cs not found at: !CS_FILE!
  exit /b 1
)

set "CSC_PATH="
if exist "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe" set "CSC_PATH=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe"
if not defined CSC_PATH if exist "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\Roslyn\csc.exe" set "CSC_PATH=C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\Roslyn\csc.exe"
if not defined CSC_PATH if exist "C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\Roslyn\csc.exe" set "CSC_PATH=C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\Roslyn\csc.exe"
if not defined CSC_PATH if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe" set "CSC_PATH=C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe"
if not defined CSC_PATH if exist "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe" set "CSC_PATH=C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe"
if not defined CSC_PATH if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\MSBuild\Current\Bin\Roslyn\csc.exe" set "CSC_PATH=C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\MSBuild\Current\Bin\Roslyn\csc.exe"
if not defined CSC_PATH if exist "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" set "CSC_PATH=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not defined CSC_PATH if exist "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe" set "CSC_PATH=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"

if not defined CSC_PATH (
  echo [ERROR] C# compiler not found. Please install Visual Studio or .NET Framework.
  exit /b 1
)

echo [INFO] Using C# compiler: !CSC_PATH!
echo.

set "ABB_SDK_PATH=C:\Program Files (x86)\ABB\SDK\PCSDK 2025"
if not exist "!ABB_SDK_PATH!" (
  echo [ERROR] ABB PC SDK not found at: !ABB_SDK_PATH!
  echo [INFO] Install ABB PC SDK 2025 first.
  exit /b 1
)

echo [INFO] Found ABB PC SDK at: !ABB_SDK_PATH!
echo.

set "REF1="
set "REF2="

if exist "!ABB_SDK_PATH!\ABB.Robotics.Controllers.PC.dll" (
  set "REF1=!ABB_SDK_PATH!\ABB.Robotics.Controllers.PC.dll"
)

if not defined REF1 if exist "!ABB_SDK_PATH!\Bin\ABB.Robotics.Controllers.dll" (
  set "REF1=!ABB_SDK_PATH!\Bin\ABB.Robotics.Controllers.dll"
)

if not defined REF1 (
  echo [ERROR] No supported ABB controller assembly found.
  echo [INFO] Checked:
  echo        !ABB_SDK_PATH!\ABB.Robotics.Controllers.PC.dll
  echo        !ABB_SDK_PATH!\Bin\ABB.Robotics.Controllers.dll
  exit /b 1
)

if exist "!ABB_SDK_PATH!\Bin\ABB.Robotics.Controllers.RapidDomain.dll" (
  set "REF2=!ABB_SDK_PATH!\Bin\ABB.Robotics.Controllers.RapidDomain.dll"
)

echo [INFO] Primary reference: !REF1!
if defined REF2 echo [INFO] Extra reference:   !REF2!
echo.

if exist "!OUTPUT_DLL!" del /f /q "!OUTPUT_DLL!" >nul 2>&1

echo [RUN] Compiling ABBBridge.dll...
if defined REF2 (
  "!CSC_PATH!" /nologo /target:library /out:"!OUTPUT_DLL!" /reference:"!REF1!" /reference:"!REF2!" "!CS_FILE!"
) else (
  "!CSC_PATH!" /nologo /target:library /out:"!OUTPUT_DLL!" /reference:"!REF1!" "!CS_FILE!"
)

if errorlevel 1 (
  echo [ERROR] Compilation failed!
  exit /b 1
)

if not exist "!OUTPUT_DLL!" (
  echo [ERROR] Output DLL not created!
  exit /b 1
)

echo [OK] Compilation successful!
echo [OK] Output: !OUTPUT_DLL!
echo.

REM Display file info
for %%F in ("!OUTPUT_DLL!") do (
  echo [INFO] File size: %%~zF bytes
  echo [INFO] Created: %%~tF
)

echo.
echo ============================================================
echo   Compilation Complete (Unified Script)
echo ============================================================
echo.
exit /b 0
