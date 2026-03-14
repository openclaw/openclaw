param(
  [string]$Name = "manual"
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$refName = "checkpoint/web-control-ui-$timestamp-$Name"

$dirty = git status --porcelain -- apps/web-control-ui
if (-not $dirty) {
  Write-Host "No changes under apps/web-control-ui. Creating tag from current HEAD: $refName"
  git tag $refName HEAD
  Write-Host "Created checkpoint tag: $refName"
  exit 0
}

git add apps/web-control-ui
$commitMessage = "checkpoint(web-control-ui): $Name [$timestamp]"
git commit -m $commitMessage | Out-Host
git tag $refName HEAD
Write-Host "Created checkpoint commit + tag: $refName"
