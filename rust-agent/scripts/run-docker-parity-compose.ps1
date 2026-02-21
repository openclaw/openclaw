param(
    [string]$Project = "openclaw-rs-parity"
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$composeFile = Join-Path $rootDir "deploy/docker-compose.parity.yml"

docker compose -p $Project -f $composeFile up --build --abort-on-container-exit --exit-code-from assertor
$status = $LASTEXITCODE

docker compose -p $Project -f $composeFile down -v --remove-orphans | Out-Null
exit $status
