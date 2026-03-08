param(
    [string]$ImageTag = "openclaw-rs-parity:latest"
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir

docker build -f "$rootDir/deploy/Dockerfile.parity" -t $ImageTag $rootDir
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

docker run --rm $ImageTag
exit $LASTEXITCODE
