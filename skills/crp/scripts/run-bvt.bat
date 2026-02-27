@echo off
:: run-bvt.bat [test_name]
:: Runs BVT scenario tests for CRP cross-subscription move.
:: Output logged to C:\temp\bvt-output.log
:: Usage: run-bvt.bat [CrossSubscriptionMove]
setlocal
set NAME=%1
if "%NAME%"=="" set NAME=CrossSubscriptionMove

echo Running BVT: %NAME%
echo Output: C:\temp\bvt-output.log
powershell.exe -NonInteractive -File "Q:\src\saia-scripts\crp\run-bvt.ps1" -Name %NAME% > C:\temp\bvt-output.log 2>&1
echo EXIT=%ERRORLEVEL% >> C:\temp\bvt-output.log
type C:\temp\bvt-output.log
