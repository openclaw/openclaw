param(
  [Parameter(Mandatory = $true)]
  [string]$Ref
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$restorePaths = @(
  'apps/web-control-ui',
  'scripts/web-control-ui-checkpoint.ps1',
  'scripts/web-control-ui-list-checkpoints.ps1',
  'scripts/web-control-ui-restore.ps1'
)

git restore --source $Ref --staged --worktree -- @restorePaths
Write-Host "Restored web-control-ui app + checkpoint scripts from $Ref"
Write-Host "Implementation note: checkpoint refs are branch-based now; legacy tag refs remain restorable."
Write-Host "Review with: git diff -- apps/web-control-ui scripts/web-control-ui-*.ps1"
