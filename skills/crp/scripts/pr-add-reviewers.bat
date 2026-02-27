@echo off
:: pr-add-reviewers.bat <PR_ID> <alias1> [alias2] ...
:: Adds optional reviewers to a PR.
:: Usage: pr-add-reviewers.bat 14092992 sukodava avlajoaga ccuibus erickuo
setlocal
set PR_ID=%1
if "%PR_ID%"=="" (
    echo Usage: pr-add-reviewers.bat ^<PR_ID^> ^<alias1^> [alias2 ...]
    exit /b 1
)
set ORG=https://dev.azure.com/msazure
shift

set REVIEWERS=
:loop
if "%1"=="" goto done
set REVIEWERS=%REVIEWERS% %1@microsoft.com
shift
goto loop

:done
if "%REVIEWERS%"=="" (
    echo No reviewers specified.
    exit /b 1
)

echo Adding optional reviewers:%REVIEWERS%
az repos pr reviewer add --id %PR_ID% --org %ORG% --reviewers%REVIEWERS% -o json 2>&1
