@echo off
:: pr-set-required-reviewer.bat <PR_ID> <reviewer_alias>
:: Marks a reviewer as required on a PR using ADO REST API.
:: Usage: pr-set-required-reviewer.bat 14092992 box
::
:: Repo IDs (Compute-CPlat-Core):
::   Project:  b32aa71e-8ed2-41b2-9d77-5bc261222004
::   Repo:     38a0e4fd-0e12-4f29-bb26-20a534d0b257
setlocal enabledelayedexpansion
set PR_ID=%1
set ALIAS=%2
if "%PR_ID%"=="" goto usage
if "%ALIAS%"=="" goto usage

set PROJECT_ID=b32aa71e-8ed2-41b2-9d77-5bc261222004
set REPO_ID=38a0e4fd-0e12-4f29-bb26-20a534d0b257
set ORG=https://msazure.visualstudio.com

:: Get access token
for /f "delims=" %%T in ('az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2^>nul') do set TOKEN=%%T
if "!TOKEN!"=="" (
    for /f "delims=" %%T in ('az account get-access-token --query accessToken -o tsv 2^>nul') do set TOKEN=%%T
)
if "!TOKEN!"=="" (
    echo ERROR: Could not get access token. Run 'az login' first.
    exit /b 1
)

:: Resolve reviewer object ID from alias
echo Looking up reviewer ID for %ALIAS%@microsoft.com...
for /f "delims=" %%I in ('az devops user show --user %ALIAS%@microsoft.com --org %ORG% --query id -o tsv 2^>nul') do set REVIEWER_ID=%%I
if "!REVIEWER_ID!"=="" (
    echo ERROR: Could not find user %ALIAS%@microsoft.com in ADO.
    exit /b 1
)
echo Reviewer ID: !REVIEWER_ID!

:: Write payload
echo {"isRequired": true, "vote": 0} > C:\temp\payload-required.json

:: Set required via REST API
curl -s -X PUT ^
  -H "Authorization: Bearer !TOKEN!" ^
  -H "Content-Type: application/json" ^
  --data-binary @C:\temp\payload-required.json ^
  "%ORG%/%PROJECT_ID%/_apis/git/repositories/%REPO_ID%/pullRequests/%PR_ID%/reviewers/!REVIEWER_ID!?api-version=7.1"
echo.
echo Done.
goto :eof

:usage
echo Usage: pr-set-required-reviewer.bat ^<PR_ID^> ^<alias^>
echo Example: pr-set-required-reviewer.bat 14092992 box
exit /b 1
