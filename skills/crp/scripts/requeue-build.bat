@echo off
:: requeue-build.bat <PR_ID> [definition_id]
:: Re-queues the MergeValidation build for a PR.
:: Default definition: 347809 (Compute-CPlat-Core-MergeValidation)
:: Usage: requeue-build.bat 14092992
setlocal
set PR_ID=%1
set DEF_ID=%2
if "%PR_ID%"=="" (
    echo Usage: requeue-build.bat ^<PR_ID^> [definition_id]
    exit /b 1
)
if "%DEF_ID%"=="" set DEF_ID=347809

set ORG=https://msazure.visualstudio.com
set PROJECT=One

echo Queuing build for PR %PR_ID% (definition %DEF_ID%)...
az pipelines build queue --definition-id %DEF_ID% --branch refs/pull/%PR_ID%/merge --org %ORG% --project %PROJECT% -o json
