$ErrorActionPreference = 'Stop'

$exe = 'C:\Program Files\SketchUp\SketchUp 2026\SketchUp\SketchUp.exe'
$root = 'C:\OpenClaw\SketchUpPoC\bootstrap\rubystartup-ping-20260410'
$wsRoot = '\\wsl.localhost\Ubuntu\home\mertb\.openclaw\workspace\sketchup-poc'
$extractorScript = Join-Path $wsRoot 'windows\extractor\sketchup-live-extractor.ps1'
$requestOutDir = 'C:\OpenClaw\SketchUpPoC\rubystartup-ping-20260410'

New-Item -ItemType Directory -Path $root -Force | Out-Null
New-Item -ItemType Directory -Path $requestOutDir -Force | Out-Null

$pingRb = Join-Path $root 'minimal-ping.rb'
$immediatePath = Join-Path $root 'minimal-ping.immediate.json'
$delayedPath = Join-Path $root 'minimal-ping.delayed.json'

@'
require 'json'
require 'fileutils'
require 'time'

IMMEDIATE_PATH = 'C:\\OpenClaw\\SketchUpPoC\\bootstrap\\rubystartup-ping-20260410\\minimal-ping.immediate.json'
DELAYED_PATH = 'C:\\OpenClaw\\SketchUpPoC\\bootstrap\\rubystartup-ping-20260410\\minimal-ping.delayed.json'

def emit(path, stage)
  FileUtils.mkdir_p(File.dirname(path))
  payload = {
    stage: stage,
    wroteAtUtc: Time.now.utc.iso8601,
    pid: Process.pid,
    rubyVersion: RUBY_VERSION,
    sketchupVersion: (Sketchup.version.to_s rescue nil),
    modelTitle: (Sketchup.active_model&.title rescue nil),
    modelPath: (Sketchup.active_model&.path rescue nil)
  }
  File.write(path, JSON.pretty_generate(payload) + "\n")
end

emit(IMMEDIATE_PATH, 'immediate')
UI.start_timer(5, false) do
  emit(DELAYED_PATH, 'delayed')
  Sketchup.quit
end
'@ | Set-Content -LiteralPath $pingRb -Encoding UTF8

function Remove-IfExists([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Wait-ForFile([string]$Path, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $Path) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Read-JsonSafe([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 20
  } catch {
    return @{ raw = (Get-Content -LiteralPath $Path -Raw) }
  }
}

function Run-Variant([string]$Name, [bool]$FocusAfterLaunch) {
  Remove-IfExists $immediatePath
  Remove-IfExists $delayedPath

  $proc = Start-Process -FilePath $exe -ArgumentList @('-RubyStartup', $pingRb) -PassThru
  if ($FocusAfterLaunch) {
    Start-Sleep -Seconds 3
    try {
      $wshell = New-Object -ComObject WScript.Shell
      $null = $wshell.AppActivate($proc.Id)
    } catch {
    }
  }

  $immediateSeen = Wait-ForFile -Path $immediatePath -TimeoutSeconds 20
  $delayedSeen = Wait-ForFile -Path $delayedPath -TimeoutSeconds 10

  $proc.Refresh()
  $stillRunning = -not $proc.HasExited
  $exitCode = $null
  if ($stillRunning) {
    try {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    } catch {
    }
  } else {
    $exitCode = $proc.ExitCode
  }

  [pscustomobject]@{
    name = $Name
    focusAfterLaunch = $FocusAfterLaunch
    pid = $proc.Id
    immediateSeen = $immediateSeen
    delayedSeen = $delayedSeen
    immediateArtifact = Read-JsonSafe $immediatePath
    delayedArtifact = Read-JsonSafe $delayedPath
    processStillRunningAtCollection = $stillRunning
    exitCode = $exitCode
  }
}

$variants = @(
  (Run-Variant -Name 'minimal-docless-no-focus' -FocusAfterLaunch:$false),
  (Run-Variant -Name 'minimal-docless-focus-after-3s' -FocusAfterLaunch:$true)
)

$requestPath = Join-Path $requestOutDir 'documentless-request-2026.json'
$responsePath = Join-Path $requestOutDir 'documentless-response-2026.json'
$outputPath = Join-Path $requestOutDir 'documentless-response-2026.output.json'
$snapshotPath = Join-Path $requestOutDir 'documentless-snapshot-2026.json'

@{
  kind = 'sketchup-live-extractor-request'
  contractVersion = '1.0.0'
  requestId = 'sketchup-poc-docless-diagnostic-2026-ping'
  requestedAtUtc = [DateTime]::UtcNow.ToString('o')
  action = 'extract-model-snapshot'
  readOnly = $true
  sourceKind = 'manual-sample'
  target = @{
    sketchupExecutablePathHint = $exe
    sketchupVersionHint = '2026'
    sketchupProcessId = $null
    documentDetected = $false
    documentNameHint = $null
    documentPathHint = $null
    documentSource = 'diagnostic-documentless'
  }
  artifacts = @{
    responseArtifactPath = $responsePath
    outputArtifactPath = $outputPath
    snapshotOutputPath = $snapshotPath
  }
  strategy = @{
    key = 'ruby-startup-empty-session'
    attachMode = 'launch-new'
    startupMode = 'ruby-startup'
    notes = @(
      'Diagnostic mode for isolating RubyStartup/bootstrap acknowledgment from document-open behavior.',
      'Launch SketchUp with -RubyStartup but without a .skp document argument.',
      'If ack is still missing, the blocker is RubyStartup/bootstrap execution rather than document-open.'
    )
  }
  options = @{
    documentName = $null
    documentPath = $null
    sketchupExePath = $exe
    bootstrapAckTimeoutSeconds = 45
    keepSketchUpOpen = $false
  }
  probeContext = @{
    probeSource = 'manual-documentless-diagnostic'
    probeStatus = 'process-running-no-document'
    metadataResultKind = 'real-probe-no-metadata'
  }
} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $requestPath -Encoding UTF8

$extractorSummary = $null
if (Test-Path -LiteralPath $extractorScript) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $extractorScript -RequestPath $requestPath
  if (Test-Path -LiteralPath $responsePath) {
    $response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json -Depth 50
    $extractorSummary = [pscustomobject]@{
      responsePath = $responsePath
      outputPath = $outputPath
      snapshotPath = $snapshotPath
      executionState = $response.executionState
      ok = $response.ok
      errorCodes = @($response.errors | ForEach-Object { $_.code })
      warningCount = @($response.warnings).Count
      bootstrapAckPath = $response.result.bootstrapAck.path
      liveModelHeader = $response.result.liveModelHeader
    }
  }
}

[pscustomobject]@{
  executedAtUtc = [DateTime]::UtcNow.ToString('o')
  exe = $exe
  pingRubyScript = $pingRb
  immediatePath = $immediatePath
  delayedPath = $delayedPath
  variants = $variants
  extractorSummary = $extractorSummary
} | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $requestOutDir 'harness-summary.json') -Encoding UTF8

Get-Content -LiteralPath (Join-Path $requestOutDir 'harness-summary.json') -Raw
