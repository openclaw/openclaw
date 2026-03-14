param(
  [Parameter(Mandatory = $true)]
  [string]$Ref
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

git restore --source $Ref --staged --worktree -- apps/web-control-ui
Write-Host "Restored apps/web-control-ui from $Ref"
Write-Host "Review with: git diff -- apps/web-control-ui"
