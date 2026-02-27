<#
.SYNOPSIS
  MAI Universe run-ledger JSONL 기록 스크립트(초안).

.DESCRIPTION
  실행 결과 1건을 JSON Lines(run-ledger.jsonl) 파일에 append 합니다.
  - 스키마 파일: ops/universe/run-ledger.schema.json
  - 필수 필드(stage/agent_role/risk_level/result 등) 포함
  - PowerShell 기본 기능만 사용 (외부 모듈 불필요)

.EXAMPLE
  .\log-run.ps1 -Project MAIBEAUTY -Stage BUILD -AgentRole builder -RiskLevel low -Result success -Summary "daily automation ok"

.EXAMPLE
  .\log-run.ps1 -Project MAIUPBIT -Stage REALIZE -AgentRole operator -RiskLevel high -ApprovalRequired -ApprovalId APP-20260226-001 -Result partial -CostEstimate 4.2 -PassThru
#>
[CmdletBinding()]
param(
  # 기록 대상 프로젝트 ID/이름
  [Parameter(Mandatory = $true)]
  [string]$Project,

  # 운영 단계 (run-ledger schema enum)
  [Parameter(Mandatory = $true)]
  [ValidateSet('COLLECT', 'DISCOVER', 'CREATE', 'BUILD', 'DEPLOY', 'REALIZE')]
  [string]$Stage,

  # 실행 에이전트 역할 (run-ledger schema enum)
  [Parameter(Mandatory = $true)]
  [ValidateSet('orchestrator', 'scout', 'builder', 'operator', 'auditor', 'analyst')]
  [string]$AgentRole,

  # 위험도
  [ValidateSet('low', 'medium', 'high', 'critical')]
  [string]$RiskLevel = 'low',

  # 실행 결과
  [Parameter(Mandatory = $true)]
  [ValidateSet('success', 'partial', 'failed', 'blocked')]
  [string]$Result,

  # 요약 메모
  [string]$Summary,

  # 비용 추정치(선택)
  [double]$CostEstimate,

  # 승인 필요 여부 (스위치 지정 시 true)
  [switch]$ApprovalRequired,

  # 승인 ID (있으면 문자열, 없으면 null)
  [string]$ApprovalId,

  # run_id 수동 지정(미지정 시 자동 생성)
  [string]$RunId,

  # timestamp 수동 지정(미지정 시 현재 시각)
  [datetime]$Timestamp,

  # 출력 경로 (기본: ops/universe/run-ledger.jsonl)
  [string]$LedgerPath,

  # true면 기록한 객체를 그대로 출력
  [switch]$PassThru
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($LedgerPath)) {
  $LedgerPath = Join-Path $scriptRoot '..\run-ledger.jsonl'
}

function New-RunId {
  # run-YYYYMMDD-HHMMSS-xxxxxxxx 형식으로 고유 ID 생성
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $shortGuid = [guid]::NewGuid().ToString('N').Substring(0, 8)
  return "run-$stamp-$shortGuid"
}

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  return [System.IO.Path]::GetFullPath($PathValue)
}

$fullLedgerPath = Resolve-FullPath -PathValue $LedgerPath
$ledgerDir = Split-Path -Parent $fullLedgerPath

if (-not (Test-Path -LiteralPath $ledgerDir)) {
  New-Item -ItemType Directory -Path $ledgerDir -Force | Out-Null
}

if (-not $PSBoundParameters.ContainsKey('RunId') -or [string]::IsNullOrWhiteSpace($RunId)) {
  $RunId = New-RunId
}

if ($PSBoundParameters.ContainsKey('Timestamp')) {
  $timestampIso = (Get-Date $Timestamp).ToString('o')
}
else {
  $timestampIso = (Get-Date).ToString('o')
}

# 스키마의 required 필드를 중심으로 ledger entry 구성
$entry = [ordered]@{
  run_id            = $RunId
  timestamp         = $timestampIso
  project           = $Project
  stage             = $Stage
  agent_role        = $AgentRole
  risk_level        = $RiskLevel
  approval_required = [bool]$ApprovalRequired.IsPresent
  approval_id       = $null
  result            = $Result
}

if ($PSBoundParameters.ContainsKey('CostEstimate')) {
  # InvariantCulture 기준 숫자 직렬화를 위해 double로 고정
  $entry.cost_estimate = [double]$CostEstimate
}

if ($PSBoundParameters.ContainsKey('ApprovalId') -and -not [string]::IsNullOrWhiteSpace($ApprovalId)) {
  $entry.approval_id = $ApprovalId
}

if ($PSBoundParameters.ContainsKey('Summary') -and -not [string]::IsNullOrWhiteSpace($Summary)) {
  $entry.summary = $Summary
}

# JSONL 한 줄 append
$jsonLine = $entry | ConvertTo-Json -Depth 6 -Compress
Add-Content -Path $fullLedgerPath -Value $jsonLine -Encoding UTF8

if ($PassThru) {
  [pscustomobject]$entry
}
else {
  Write-Host ("[log-run] appended: {0} -> {1}" -f $RunId, $fullLedgerPath)
}
