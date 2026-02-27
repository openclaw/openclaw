@echo off
:: ado-diff.bat [branch] [base]
:: Shows three-dot diff of a branch against master (ADO PR-style).
:: Defaults to cross-subscription-rm-tests branch vs origin/master.
:: Usage: ado-diff.bat [branch] [base]
setlocal
set BRANCH=%1
set BASE=%2
if "%BRANCH%"=="" set BRANCH=dev/dchitoraga/cross-subscription-rm-tests
if "%BASE%"=="" set BASE=origin/master

cd /d Q:\src\Compute-CPlat-Core
git fetch origin master --quiet 2>&1

echo === Changed files (%BASE%...%BRANCH%) ===
git diff %BASE%...%BRANCH% --name-only

echo.
echo === UnitTests only ===
git diff %BASE%...%BRANCH% --name-only -- src/CRP/Dev/UnitTests/
