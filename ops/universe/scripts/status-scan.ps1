<#
.SYNOPSIS
  주요 레포 git 상태 스캔 스크립트(초안).

.DESCRIPTION
  project-registry.yaml을 기반으로 로컬 레포를 찾아 git 상태를 수집하고,
  YAML 보고서(repo-status.yaml)를 생성합니다.

  수집 항목:
  - branch / ahead / behind
  - staged / unstaged / untracked 변경 수
  - clean 여부
  - 탐지 실패/오류 메시지

.NOTES
  - YAML 파서는 사용하지 않고, 현재 registry 구조에 맞춘 경량 파싱을 사용합니다.
  - 레포 경로 자동 탐색 루트는 -SearchRoots 로 확장 가능합니다.

.EXAMPLE
  .\status-scan.ps1

.EXAMPLE
  .\status-scan.ps1 -SearchRoots C:\TEST,D:\WORK -ExtraRepoPath C:\TEST\MAIBEAUTY
#>
[CmdletBinding()]
param(
  # 입력 registry
  [string]$RegistryPath,

  # 출력 YAML
  [string]$OutputPath,

  # 자동 탐색 루트 (필요 시 추가)
  [string[]]$SearchRoots = @('C:\TEST'),

  # registry 외 추가 스캔 대상 레포 경로
  [string[]]$ExtraRepoPath = @(),

  # 현재 workspace(C:\MAIBOT)도 보고서에 포함
  [switch]$IncludeWorkspaceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RegistryPath)) {
  $RegistryPath = Join-Path $scriptRoot '..\project-registry.yaml'
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $scriptRoot '..\repo-status.yaml'
}

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  return [System.IO.Path]::GetFullPath($PathValue)
}

function Quote-Yaml {
  param([object]$Value)

  if ($null -eq $Value) { return 'null' }

  if ($Value -is [bool]) {
    return $Value.ToString().ToLowerInvariant()
  }

  if ($Value -is [byte] -or $Value -is [sbyte] -or
      $Value -is [int16] -or $Value -is [uint16] -or
      $Value -is [int32] -or $Value -is [uint32] -or
      $Value -is [int64] -or $Value -is [uint64] -or
      $Value -is [single] -or $Value -is [double] -or $Value -is [decimal]) {
    return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0}', $Value)
  }

  $text = [string]$Value
  if ($text.Length -eq 0) {
    return '""'
  }

  if ($text -match '[:#\[\]\{\},&\*\?\|<>=!%@`]' -or
      $text -match '^\s|\s$' -or
      $text -match '^(true|false|null|~|yes|no|on|off)$' -or
      $text -match '^[0-9]+(\.[0-9]+)?$') {
    $escaped = $text.Replace('\', '\\').Replace('"', '\"')
    return '"' + $escaped + '"'
  }

  return $text
}

function Trim-YamlScalar {
  param([string]$Value)

  if ($null -eq $Value) {
    return ''
  }

  $v = $Value.Trim()

  if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
    if ($v.Length -ge 2) {
      $v = $v.Substring(1, $v.Length - 2)
    }
  }

  if ($v -eq 'null' -or $v -eq '~') {
    return $null
  }

  return $v
}

function Sanitize-RemoteUrl {
  param([string]$Url)

  if ([string]::IsNullOrWhiteSpace($Url)) {
    return $null
  }

  try {
    $uri = [System.Uri]$Url
    if (-not [string]::IsNullOrWhiteSpace($uri.UserInfo)) {
      $builder = New-Object System.UriBuilder($uri)
      $builder.UserName = ''
      $builder.Password = ''
      return $builder.Uri.AbsoluteUri.TrimEnd('/')
    }
  }
  catch {
    # pass-through to regex fallback
  }

  return ($Url -replace '://[^/@]+@', '://***@')
}

function Get-RepoNameFromUrl {
  param([string]$Url)

  if ([string]::IsNullOrWhiteSpace($Url)) {
    return ''
  }

  $clean = $Url.Trim()
  if ($clean.EndsWith('.git')) {
    $clean = $clean.Substring(0, $clean.Length - 4)
  }

  $lastSlash = $clean.LastIndexOf('/')
  if ($lastSlash -ge 0 -and $lastSlash -lt ($clean.Length - 1)) {
    return $clean.Substring($lastSlash + 1)
  }

  return $clean
}

function Parse-ProjectRegistry {
  param([Parameter(Mandatory = $true)][string]$Path)

  $items = New-Object System.Collections.Generic.List[object]

  if (-not (Test-Path -LiteralPath $Path)) {
    return $items
  }

  $lines = Get-Content -Path $Path -Encoding UTF8

  $currentProjectId = ''
  $currentRepo = ''

  foreach ($rawLine in $lines) {
    $line = $rawLine.TrimEnd()

    # 새 프로젝트 블록 시작 (예: "- project_id: MAIBEAUTY")
    if ($line -match '^\s*-\s*project_id:\s*(.+)$') {
      if (-not [string]::IsNullOrWhiteSpace($currentProjectId) -or -not [string]::IsNullOrWhiteSpace($currentRepo)) {
        $items.Add([pscustomobject]@{
          project_id = $currentProjectId
          repo       = $currentRepo
          repo_name  = (Get-RepoNameFromUrl -Url $currentRepo)
        })
      }

      $currentProjectId = Trim-YamlScalar -Value $Matches[1]
      $currentRepo = ''
      continue
    }

    # 같은 블록 내 repo 라인
    if ($line -match '^\s*repo:\s*(.+)$') {
      $currentRepo = Trim-YamlScalar -Value $Matches[1]
      continue
    }
  }

  # 마지막 블록 flush
  if (-not [string]::IsNullOrWhiteSpace($currentProjectId) -or -not [string]::IsNullOrWhiteSpace($currentRepo)) {
    $items.Add([pscustomobject]@{
      project_id = $currentProjectId
      repo       = $currentRepo
      repo_name  = (Get-RepoNameFromUrl -Url $currentRepo)
    })
  }

  return $items
}

function Get-CandidatePaths {
  param(
    [string]$ProjectId,
    [string]$RepoName,
    [string]$WorkspaceRoot,
    [string[]]$Roots
  )

  $list = New-Object System.Collections.Generic.List[string]

  foreach ($root in @($WorkspaceRoot) + $Roots) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }

    if (-not [string]::IsNullOrWhiteSpace($RepoName)) {
      $list.Add((Join-Path $root $RepoName))
      $list.Add((Join-Path $root ($RepoName -replace '[^A-Za-z0-9._-]', '')))
      $list.Add((Join-Path $root ($RepoName -replace '[^A-Za-z0-9]', '')))
    }

    if (-not [string]::IsNullOrWhiteSpace($ProjectId)) {
      $list.Add((Join-Path $root $ProjectId))
      $list.Add((Join-Path $root ($ProjectId -replace '[^A-Za-z0-9._-]', '')))
      $list.Add((Join-Path $root ($ProjectId -replace '[^A-Za-z0-9]', '')))
    }
  }

  # 중복 제거 + 존재 경로만 반환
  $unique = @{}
  $result = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in $list) {
    try {
      $full = [System.IO.Path]::GetFullPath($candidate)
    }
    catch {
      continue
    }

    if ($unique.ContainsKey($full)) {
      continue
    }

    $unique[$full] = $true

    if (Test-Path -LiteralPath $full) {
      $result.Add($full)
    }
  }

  return $result
}

function Resolve-RepoPath {
  param(
    [string]$ProjectId,
    [string]$RepoName,
    [string]$WorkspaceRoot,
    [string[]]$Roots
  )

  $candidates = Get-CandidatePaths -ProjectId $ProjectId -RepoName $RepoName -WorkspaceRoot $WorkspaceRoot -Roots $Roots

  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $path '.git')) {
      return $path
    }
  }

  return $null
}

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)][string]$RepoPath,
    [Parameter(Mandatory = $true)][string[]]$Args
  )

  $hadNativePref = $false
  $nativePrefBackup = $null

  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $hadNativePref = $true
    $nativePrefBackup = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }

  try {
    try {
      $output = & git -C $RepoPath @Args 2>$null
      $exitCode = $LASTEXITCODE
    }
    catch {
      $output = @()
      if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) {
        $exitCode = $LASTEXITCODE
      }
      else {
        $exitCode = 1
      }
    }
  }
  finally {
    if ($hadNativePref) {
      $PSNativeCommandUseErrorActionPreference = $nativePrefBackup
    }
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output   = @($output)
  }
}

function Get-GitScan {
  param([Parameter(Mandatory = $true)][string]$RepoPath)

  $branchRes = Invoke-Git -RepoPath $RepoPath -Args @('rev-parse', '--abbrev-ref', 'HEAD')
  if ($branchRes.ExitCode -ne 0) {
    return [pscustomobject]@{
      found      = $false
      error      = 'not-a-git-repo'
      branch     = $null
      ahead      = $null
      behind     = $null
      staged     = 0
      unstaged   = 0
      untracked  = 0
      is_clean   = $false
      status_hint = 'error'
      remote_url = $null
    }
  }

  $branch = if ($branchRes.Output.Count -gt 0) { [string]$branchRes.Output[0] } else { 'HEAD' }

  $statusRes = Invoke-Git -RepoPath $RepoPath -Args @('status', '--porcelain')
  $staged = 0
  $unstaged = 0
  $untracked = 0

  foreach ($line in $statusRes.Output) {
    $text = [string]$line
    if ([string]::IsNullOrWhiteSpace($text)) {
      continue
    }

    if ($text.StartsWith('??')) {
      $untracked++
      continue
    }

    if ($text.Length -ge 2) {
      $indexStatus = $text.Substring(0, 1)
      $workTreeStatus = $text.Substring(1, 1)

      if ($indexStatus -ne ' ' -and $indexStatus -ne '?') {
        $staged++
      }

      if ($workTreeStatus -ne ' ' -and $workTreeStatus -ne '?') {
        $unstaged++
      }
    }
  }

  $remoteRes = Invoke-Git -RepoPath $RepoPath -Args @('remote', 'get-url', 'origin')
  $remoteUrl = if ($remoteRes.ExitCode -eq 0 -and $remoteRes.Output.Count -gt 0) {
    Sanitize-RemoteUrl -Url ([string]$remoteRes.Output[0])
  }
  else {
    $null
  }

  $upstreamRes = Invoke-Git -RepoPath $RepoPath -Args @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
  $ahead = $null
  $behind = $null
  $hasUpstream = ($upstreamRes.ExitCode -eq 0 -and $upstreamRes.Output.Count -gt 0)

  if ($hasUpstream) {
    $upstreamRef = [string]$upstreamRes.Output[0]
    $abRes = Invoke-Git -RepoPath $RepoPath -Args @('rev-list', '--left-right', '--count', ($upstreamRef + '...HEAD'))
    if ($abRes.ExitCode -eq 0 -and $abRes.Output.Count -gt 0) {
      $parts = ([string]$abRes.Output[0]).Trim() -split '\s+'
      if ($parts.Count -ge 2) {
        $behind = [int]$parts[0]
        $ahead = [int]$parts[1]
      }
    }
  }

  $isClean = ($staged -eq 0 -and $unstaged -eq 0 -and $untracked -eq 0)

  $statusHint = 'dirty'
  if ($isClean) {
    $statusHint = 'clean'
  }
  if ($branch -eq 'HEAD') {
    $statusHint = 'detached'
  }
  if (-not $hasUpstream -and $statusHint -eq 'clean') {
    $statusHint = 'clean-no-upstream'
  }

  return [pscustomobject]@{
    found       = $true
    error       = $null
    branch      = $branch
    ahead       = $ahead
    behind      = $behind
    staged      = $staged
    unstaged    = $unstaged
    untracked   = $untracked
    is_clean    = $isClean
    status_hint = $statusHint
    remote_url  = $remoteUrl
  }
}

$fullRegistryPath = Resolve-FullPath -PathValue $RegistryPath
$fullOutputPath = Resolve-FullPath -PathValue $OutputPath
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))

$outputDir = Split-Path -Parent $fullOutputPath
if (-not (Test-Path -LiteralPath $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$registryItems = Parse-ProjectRegistry -Path $fullRegistryPath

# 대상 목록 구성
$targets = New-Object System.Collections.Generic.List[object]

foreach ($item in $registryItems) {
  $targets.Add([pscustomobject]@{
    project_id = [string]$item.project_id
    repo_url   = [string]$item.repo
    repo_name  = [string]$item.repo_name
    source     = 'registry'
    local_path = $null
  })
}

# workspace root를 주요 레포로 포함 (옵션)
if ($IncludeWorkspaceRoot.IsPresent) {
  $targets.Add([pscustomobject]@{
    project_id = 'MAIBOT_WORKSPACE'
    repo_url   = $null
    repo_name  = (Split-Path $workspaceRoot -Leaf)
    source     = 'workspace'
    local_path = $workspaceRoot
  })
}

foreach ($extra in $ExtraRepoPath) {
  if ([string]::IsNullOrWhiteSpace($extra)) { continue }

  $targets.Add([pscustomobject]@{
    project_id = (Split-Path $extra -Leaf)
    repo_url   = $null
    repo_name  = (Split-Path $extra -Leaf)
    source     = 'extra'
    local_path = $extra
  })
}

$seenKey = @{}
$results = New-Object System.Collections.Generic.List[object]

foreach ($target in $targets) {
  $projectId = [string]$target.project_id
  $repoUrl = [string]$target.repo_url
  $repoName = [string]$target.repo_name

  $targetPath = $null
  if (-not [string]::IsNullOrWhiteSpace([string]$target.local_path)) {
    $targetPath = [System.IO.Path]::GetFullPath([string]$target.local_path)
  }
  else {
    $targetPath = Resolve-RepoPath -ProjectId $projectId -RepoName $repoName -WorkspaceRoot $workspaceRoot -Roots $SearchRoots
  }

  $dedupeKey = "{0}|{1}" -f $projectId, $repoUrl
  if ($seenKey.ContainsKey($dedupeKey)) {
    continue
  }
  $seenKey[$dedupeKey] = $true

  if ([string]::IsNullOrWhiteSpace($targetPath) -or -not (Test-Path -LiteralPath $targetPath)) {
    $results.Add([pscustomobject]@{
      project_id  = $projectId
      repo_url    = $repoUrl
      source      = [string]$target.source
      local_path  = $null
      found       = $false
      branch      = $null
      ahead       = $null
      behind      = $null
      staged      = 0
      unstaged    = 0
      untracked   = 0
      is_clean    = $false
      status_hint = 'missing'
      error       = 'repo-path-not-found'
      remote_url  = $null
    })
    continue
  }

  $scan = Get-GitScan -RepoPath $targetPath

  $results.Add([pscustomobject]@{
    project_id  = $projectId
    repo_url    = $repoUrl
    source      = [string]$target.source
    local_path  = $targetPath
    found       = [bool]$scan.found
    branch      = $scan.branch
    ahead       = $scan.ahead
    behind      = $scan.behind
    staged      = [int]$scan.staged
    unstaged    = [int]$scan.unstaged
    untracked   = [int]$scan.untracked
    is_clean    = [bool]$scan.is_clean
    status_hint = [string]$scan.status_hint
    error       = $scan.error
    remote_url  = $scan.remote_url
  })
}

$reposDetected = [int]$results.Count
$reposScanned = [int](@($results | Where-Object { $_.found -eq $true }).Count)
$missingCount = [int](@($results | Where-Object { $_.found -eq $false }).Count)
$cleanCount = [int](@($results | Where-Object { $_.found -eq $true -and $_.is_clean -eq $true }).Count)
$dirtyCount = [int](@($results | Where-Object { $_.found -eq $true -and $_.is_clean -eq $false }).Count)

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Auto-generated by ops/universe/scripts/status-scan.ps1')
$lines.Add('version: 1')
$lines.Add(('generated_at: {0}' -f (Quote-Yaml -Value (Get-Date).ToString('o'))))
$lines.Add(('registry_path: {0}' -f (Quote-Yaml -Value $fullRegistryPath)))
$lines.Add('summary:')
$lines.Add(('  repos_detected: {0}' -f $reposDetected))
$lines.Add(('  repos_scanned: {0}' -f $reposScanned))
$lines.Add(('  clean: {0}' -f $cleanCount))
$lines.Add(('  dirty: {0}' -f $dirtyCount))
$lines.Add(('  missing: {0}' -f $missingCount))

if ($results.Count -eq 0) {
  $lines.Add('repos: []')
}
else {
  $lines.Add('repos:')

  foreach ($r in $results) {
    $lines.Add(('  - project_id: {0}' -f (Quote-Yaml -Value $r.project_id)))
    $lines.Add(('    source: {0}' -f (Quote-Yaml -Value $r.source)))
    $lines.Add(('    repo_url: {0}' -f (Quote-Yaml -Value $r.repo_url)))
    $lines.Add(('    local_path: {0}' -f (Quote-Yaml -Value $r.local_path)))
    $lines.Add(('    found: {0}' -f (Quote-Yaml -Value $r.found)))
    $lines.Add(('    branch: {0}' -f (Quote-Yaml -Value $r.branch)))
    $lines.Add(('    ahead: {0}' -f (Quote-Yaml -Value $r.ahead)))
    $lines.Add(('    behind: {0}' -f (Quote-Yaml -Value $r.behind)))
    $lines.Add('    changes:')
    $lines.Add(('      staged: {0}' -f $r.staged))
    $lines.Add(('      unstaged: {0}' -f $r.unstaged))
    $lines.Add(('      untracked: {0}' -f $r.untracked))
    $lines.Add(('    is_clean: {0}' -f (Quote-Yaml -Value $r.is_clean)))
    $lines.Add(('    status_hint: {0}' -f (Quote-Yaml -Value $r.status_hint)))
    $lines.Add(('    error: {0}' -f (Quote-Yaml -Value $r.error)))
    $lines.Add(('    remote_url: {0}' -f (Quote-Yaml -Value $r.remote_url)))
  }
}

$yamlText = [string]::Join([Environment]::NewLine, $lines)
Set-Content -Path $fullOutputPath -Value $yamlText -Encoding UTF8

Write-Host ("[status-scan] wrote: {0}" -f $fullOutputPath)
