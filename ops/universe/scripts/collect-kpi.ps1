<#
.SYNOPSIS
  MAI Universe KPI 요약 YAML 생성 스크립트(초안).

.DESCRIPTION
  run-ledger JSONL 파일을 읽어 기간(WindowDays) 기준 KPI를 집계하고,
  사람이 읽기 쉬운 YAML 요약 파일을 생성합니다.

  주요 집계:
  - 전체 성공률/딜리버리율(success+partial)
  - 승인 필요 비율, 고위험(high/critical) 비율
  - 결과/단계 분포
  - 프로젝트별 실행 통계(Top N)

.EXAMPLE
  .\collect-kpi.ps1

.EXAMPLE
  .\collect-kpi.ps1 -WindowDays 30 -TopProjects 50 -OutputPath ..\kpi-weekly.yaml
#>
[CmdletBinding()]
param(
  # 입력 ledger(JSONL)
  [string]$LedgerPath,

  # 출력 KPI YAML
  [string]$OutputPath,

  # 최근 N일 윈도우
  [ValidateRange(1, 3650)]
  [int]$WindowDays = 7,

  # 프로젝트별 집계 최대 출력 개수
  [ValidateRange(1, 1000)]
  [int]$TopProjects = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($LedgerPath)) {
  $LedgerPath = Join-Path $scriptRoot '..\run-ledger.jsonl'
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $scriptRoot '..\kpi-summary.yaml'
}

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  return [System.IO.Path]::GetFullPath($PathValue)
}

function ConvertTo-InvariantString {
  param([Parameter(Mandatory = $true)][object]$Value)
  return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0}', $Value)
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
    return (ConvertTo-InvariantString -Value $Value)
  }

  $text = [string]$Value
  if ($text.Length -eq 0) {
    return '""'
  }

  # YAML에서 해석 충돌 가능성이 있는 문자열은 항상 double-quote 처리
  if ($text -match '[:#\[\]\{\},&\*\?\|<>=!%@`]' -or
      $text -match '^\s|\s$' -or
      $text -match '^(true|false|null|~|yes|no|on|off)$' -or
      $text -match '^[0-9]+(\.[0-9]+)?$') {
    $escaped = $text.Replace('\', '\\').Replace('"', '\"')
    return '"' + $escaped + '"'
  }

  return $text
}

function Get-OptionalProperty {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $prop = $Object.PSObject.Properties[$Name]
  if ($null -ne $prop) {
    return $prop.Value
  }

  return $null
}

$fullLedgerPath = Resolve-FullPath -PathValue $LedgerPath
$fullOutputPath = Resolve-FullPath -PathValue $OutputPath

$outputDir = Split-Path -Parent $fullOutputPath
if (-not (Test-Path -LiteralPath $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$rawLines = @()
if (Test-Path -LiteralPath $fullLedgerPath) {
  $rawLines = @(Get-Content -Path $fullLedgerPath -Encoding UTF8)
}

$entries = New-Object System.Collections.Generic.List[object]
$malformedLines = 0

foreach ($line in $rawLines) {
  if ([string]::IsNullOrWhiteSpace($line)) {
    continue
  }

  try {
    $entry = $line | ConvertFrom-Json -ErrorAction Stop
    $entries.Add($entry)
  }
  catch {
    # JSONL 무결성 확인용 카운트
    $malformedLines++
  }
}

$now = Get-Date
$windowStart = $now.AddDays(-1 * [math]::Abs($WindowDays))

$windowEntries = @(
  $entries | Where-Object {
    $timestampRaw = Get-OptionalProperty -Object $_ -Name 'timestamp'
    if ($null -eq $timestampRaw -or [string]::IsNullOrWhiteSpace([string]$timestampRaw)) {
      return $false
    }

    try {
      ([datetime]$timestampRaw) -ge $windowStart
    }
    catch {
      $false
    }
  }
)

$results = [ordered]@{
  success = 0
  partial = 0
  failed  = 0
  blocked = 0
}

$stages = [ordered]@{
  COLLECT  = 0
  DISCOVER = 0
  CREATE   = 0
  BUILD    = 0
  DEPLOY   = 0
  REALIZE  = 0
}

$approvalRequiredCount = 0
$highRiskCount = 0
$costSum = 0.0
$costCount = 0

# project => 통계 버킷
$projectStats = @{}

foreach ($entry in $windowEntries) {
  $resultKey = [string](Get-OptionalProperty -Object $entry -Name 'result')
  if ([string]::IsNullOrWhiteSpace($resultKey)) { $resultKey = 'unknown' }
  if (-not $results.Contains($resultKey)) { $results[$resultKey] = 0 }
  $results[$resultKey] = [int]$results[$resultKey] + 1

  $stageKey = [string](Get-OptionalProperty -Object $entry -Name 'stage')
  if ([string]::IsNullOrWhiteSpace($stageKey)) { $stageKey = 'UNKNOWN' }
  if (-not $stages.Contains($stageKey)) { $stages[$stageKey] = 0 }
  $stages[$stageKey] = [int]$stages[$stageKey] + 1

  $risk = [string](Get-OptionalProperty -Object $entry -Name 'risk_level')
  if ($risk -eq 'high' -or $risk -eq 'critical') {
    $highRiskCount++
  }

  $approvalRequired = Get-OptionalProperty -Object $entry -Name 'approval_required'
  if ($approvalRequired -eq $true) {
    $approvalRequiredCount++
  }

  $hasCost = $false
  $costValue = 0.0
  $entryCost = Get-OptionalProperty -Object $entry -Name 'cost_estimate'
  if ($null -ne $entryCost -and -not [string]::IsNullOrWhiteSpace([string]$entryCost)) {
    try {
      $costValue = [double]$entryCost
      $hasCost = $true
    }
    catch {
      $hasCost = $false
    }
  }

  if ($hasCost) {
    $costSum += $costValue
    $costCount++
  }

  $project = [string](Get-OptionalProperty -Object $entry -Name 'project')
  if ([string]::IsNullOrWhiteSpace($project)) {
    $project = 'UNKNOWN'
  }

  if (-not $projectStats.ContainsKey($project)) {
    $projectStats[$project] = [ordered]@{
      runs       = 0
      success    = 0
      partial    = 0
      failed     = 0
      blocked    = 0
      approvals  = 0
      high_risk  = 0
      cost_sum   = 0.0
      cost_count = 0
    }
  }

  $bucket = $projectStats[$project]
  $bucket.runs++

  switch ($resultKey) {
    'success' { $bucket.success++ }
    'partial' { $bucket.partial++ }
    'failed'  { $bucket.failed++ }
    'blocked' { $bucket.blocked++ }
  }

  if ($approvalRequired -eq $true) {
    $bucket.approvals++
  }

  if ($risk -eq 'high' -or $risk -eq 'critical') {
    $bucket.high_risk++
  }

  if ($hasCost) {
    $bucket.cost_sum += $costValue
    $bucket.cost_count++
  }
}

$totalInWindow = [int]$windowEntries.Count
$successCount = if ($results.Contains('success')) { [int]$results['success'] } else { 0 }
$partialCount = if ($results.Contains('partial')) { [int]$results['partial'] } else { 0 }

$successRate = if ($totalInWindow -gt 0) { [math]::Round($successCount / $totalInWindow, 4) } else { 0.0 }
$deliveryRate = if ($totalInWindow -gt 0) { [math]::Round(($successCount + $partialCount) / $totalInWindow, 4) } else { 0.0 }
$approvalRate = if ($totalInWindow -gt 0) { [math]::Round($approvalRequiredCount / $totalInWindow, 4) } else { 0.0 }
$highRiskRate = if ($totalInWindow -gt 0) { [math]::Round($highRiskCount / $totalInWindow, 4) } else { 0.0 }
$avgCost = if ($costCount -gt 0) { [math]::Round($costSum / $costCount, 4) } else { 0.0 }

$projectRows = @(
  $projectStats.GetEnumerator() |
    Sort-Object -Property @{ Expression = { $_.Value.runs }; Descending = $true }, @{ Expression = { $_.Key }; Descending = $false } |
    Select-Object -First $TopProjects
)

# YAML 출력 생성
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Auto-generated by ops/universe/scripts/collect-kpi.ps1')
$lines.Add(('version: {0}' -f 1))
$lines.Add(('generated_at: {0}' -f (Quote-Yaml -Value $now.ToString('o'))))
$lines.Add(('window_days: {0}' -f $WindowDays))
$lines.Add('source:')
$lines.Add(('  ledger_path: {0}' -f (Quote-Yaml -Value $fullLedgerPath)))
$lines.Add(('  runs_total_lines: {0}' -f $rawLines.Count))
$lines.Add(('  parsed_entries: {0}' -f $entries.Count))
$lines.Add(('  malformed_lines: {0}' -f $malformedLines))
$lines.Add(('  runs_in_window: {0}' -f $totalInWindow))
$lines.Add('summary:')
$lines.Add(('  success_rate: {0}' -f (ConvertTo-InvariantString -Value $successRate)))
$lines.Add(('  delivery_rate: {0}' -f (ConvertTo-InvariantString -Value $deliveryRate)))
$lines.Add(('  approval_required_rate: {0}' -f (ConvertTo-InvariantString -Value $approvalRate)))
$lines.Add(('  high_risk_rate: {0}' -f (ConvertTo-InvariantString -Value $highRiskRate)))
$lines.Add(('  avg_cost_estimate: {0}' -f (ConvertTo-InvariantString -Value $avgCost)))

$lines.Add('distributions:')
$lines.Add('  by_result:')
foreach ($key in $results.Keys) {
  $lines.Add(('    {0}: {1}' -f $key, [int]$results[$key]))
}

$lines.Add('  by_stage:')
foreach ($key in $stages.Keys) {
  $lines.Add(('    {0}: {1}' -f $key, [int]$stages[$key]))
}

if ($projectRows.Count -eq 0) {
  $lines.Add('projects: []')
}
else {
  $lines.Add('projects:')

  foreach ($row in $projectRows) {
    $projectName = [string]$row.Key
    $bucket = $row.Value

    $projectSuccessRate = if ($bucket.runs -gt 0) {
      [math]::Round(($bucket.success / $bucket.runs), 4)
    }
    else {
      0.0
    }

    $projectAvgCost = if ($bucket.cost_count -gt 0) {
      [math]::Round(($bucket.cost_sum / $bucket.cost_count), 4)
    }
    else {
      0.0
    }

    $lines.Add(('  - project: {0}' -f (Quote-Yaml -Value $projectName)))
    $lines.Add(('    runs: {0}' -f $bucket.runs))
    $lines.Add(('    success: {0}' -f $bucket.success))
    $lines.Add(('    partial: {0}' -f $bucket.partial))
    $lines.Add(('    failed: {0}' -f $bucket.failed))
    $lines.Add(('    blocked: {0}' -f $bucket.blocked))
    $lines.Add(('    success_rate: {0}' -f (ConvertTo-InvariantString -Value $projectSuccessRate)))
    $lines.Add(('    approvals: {0}' -f $bucket.approvals))
    $lines.Add(('    high_risk: {0}' -f $bucket.high_risk))
    $lines.Add(('    avg_cost_estimate: {0}' -f (ConvertTo-InvariantString -Value $projectAvgCost)))
  }
}

$yamlText = [string]::Join([Environment]::NewLine, $lines)
Set-Content -Path $fullOutputPath -Value $yamlText -Encoding UTF8

Write-Host ("[collect-kpi] wrote: {0}" -f $fullOutputPath)
