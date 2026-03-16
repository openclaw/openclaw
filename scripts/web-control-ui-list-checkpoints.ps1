param(
  [int]$Limit = 20,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Parse-CheckpointRef {
  param(
    [string]$Ref,
    [string]$Sha,
    [string]$Subject,
    [string]$Kind
  )

  $match = [Regex]::Match($Ref, '^checkpoint/web-control-ui-(\d{8})-(\d{6})-(.+)$')
  if (-not $match.Success) {
    return $null
  }

  $datePart = $match.Groups[1].Value
  $timePart = $match.Groups[2].Value
  $rawName = $match.Groups[3].Value
  $label = ($rawName -replace '-', ' ').Trim()
  if (-not $label) {
    $label = 'manual'
  }

  $timestamp = Get-Date -Year $datePart.Substring(0, 4) -Month $datePart.Substring(4, 2) -Day $datePart.Substring(6, 2) -Hour $timePart.Substring(0, 2) -Minute $timePart.Substring(2, 2) -Second $timePart.Substring(4, 2)

  [pscustomobject]@{
    ref = $Ref
    kind = $Kind
    timestamp = $timestamp.ToString('s')
    displayTime = $timestamp.ToString('yyyy-MM-dd HH:mm:ss')
    name = $rawName
    label = $label
    shortSha = $Sha
    subject = $Subject
  }
}

$items = @()

$branchLines = git for-each-ref refs/heads/checkpoint/web-control-ui-* --format='%(refname:short)`t%(objectname:short)`t%(subject)'
foreach ($line in $branchLines) {
  if (-not $line) { continue }
  $parts = $line -split "`t", 3
  $ref = $parts[0]
  $sha = if ($parts.Length -ge 2) { $parts[1] } else { '' }
  $subject = if ($parts.Length -ge 3) { $parts[2] } else { '' }
  $parsed = Parse-CheckpointRef -Ref $ref -Sha $sha -Subject $subject -Kind 'branch'
  if ($parsed) {
    $items += $parsed
  }
}

$tagLines = git tag --list 'checkpoint/web-control-ui-*'
foreach ($tag in $tagLines) {
  if (-not $tag) { continue }
  if ($items.ref -contains $tag) { continue }
  $sha = (git rev-list -n 1 $tag).Trim()
  $shortSha = if ($sha.Length -ge 7) { $sha.Substring(0, 7) } else { $sha }
  $subject = (git log -1 --format=%s $tag).Trim()
  $parsed = Parse-CheckpointRef -Ref $tag -Sha $shortSha -Subject $subject -Kind 'legacy-tag'
  if ($parsed) {
    $items += $parsed
  }
}

$sorted = $items |
  Sort-Object -Property @{ Expression = { $_.timestamp }; Descending = $true }, @{ Expression = { $_.ref }; Descending = $true } |
  Select-Object -First $Limit

if ($Json) {
  $sorted | ConvertTo-Json -Depth 5
  exit 0
}

$sorted | ForEach-Object {
  "{0}`t{1}`t{2}`t{3}`t{4}" -f $_.displayTime, $_.label, $_.ref, $_.kind, $_.shortSha
}
