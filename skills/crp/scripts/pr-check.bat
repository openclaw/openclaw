@echo off
:: pr-check.bat [PR_ID]
:: Shows PR status and all policy gates for a given PR.
:: Usage: pr-check.bat 14092992
setlocal
set PR_ID=%1
if "%PR_ID%"=="" (
    echo Usage: pr-check.bat ^<PR_ID^>
    exit /b 1
)
set ORG=https://dev.azure.com/msazure

echo === PR Details ===
az repos pr show --id %PR_ID% --org %ORG% -o json 2>&1
echo.
echo === PR Policies ===
az repos pr policy list --id %PR_ID% --org %ORG% -o json 2>&1
