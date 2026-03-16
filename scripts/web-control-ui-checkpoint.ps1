param(
  [string]$Name = "manual"
)

$ErrorActionPreference = 'Stop'

function Convert-ToCheckpointSlug {
  param([string]$Value)

  $normalized = ($Value ?? '').Trim().ToLowerInvariant()
  if (-not $normalized) {
    return 'manual'
  }

  $slug = [Regex]::Replace($normalized, '[^a-z0-9]+', '-')
  $slug = $slug.Trim('-')
  if (-not $slug) {
    return 'manual'
  }
  return $slug
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$displayName = ($Name ?? '').Trim()
if (-not $displayName) {
  $displayName = 'manual'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$slug = Convert-ToCheckpointSlug -Value $displayName
$refName = "checkpoint/web-control-ui-$timestamp-$slug"

$trackedPaths = @(
  'apps/web-control-ui',
  'scripts/web-control-ui-checkpoint.ps1',
  'scripts/web-control-ui-list-checkpoints.ps1',
  'scripts/web-control-ui-restore.ps1'
)

$dirty = git status --porcelain -- @trackedPaths
if (-not $dirty) {
  Write-Host "No changes under apps/web-control-ui + checkpoint scripts. Creating checkpoint branch from current HEAD: $refName"
  git branch -f $refName HEAD | Out-Null
  Write-Host "Created checkpoint branch: $refName"
  Write-Host "Checkpoint note: $displayName"
  exit 0
}

git add -- @trackedPaths
$commitMessage = "checkpoint(web-control-ui): $displayName [$timestamp]"
git commit -m $commitMessage | Out-Host
git branch -f $refName HEAD | Out-Null
Write-Host "Created checkpoint commit + branch: $refName"
Write-Host "Checkpoint note: $displayName"
