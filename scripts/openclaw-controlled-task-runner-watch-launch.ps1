param(
  [string]$RepoRoot = "",
  [string]$TaskId = "",
  [int]$IntervalMs = 30000,
  [int]$RestartDelayMs = 3000,
  [int]$MaxCycles = 0,
  [switch]$Preview,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-ProcessAlive {
  param([int]$ProcessId)
  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-ProcessCommandLine {
  param([int]$ProcessId)
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if ($null -eq $process) {
      return ""
    }
    return [string]$process.CommandLine
  } catch {
    return ""
  }
}

function Test-WatchProcess {
  param(
    [int]$ProcessId,
    [string]$ExpectedScript
  )
  $commandLine = (Get-ProcessCommandLine -ProcessId $ProcessId).Replace("\", "/").ToLowerInvariant()
  $expected = $ExpectedScript.Replace("\", "/").ToLowerInvariant()
  return -not [string]::IsNullOrWhiteSpace($commandLine) -and $commandLine.Contains($expected)
}

function Stop-WatchProcess {
  param(
    [int]$ProcessId,
    [string]$ExpectedScript
  )
  if (-not (Test-WatchProcess -ProcessId $ProcessId -ExpectedScript $ExpectedScript)) {
    throw "Refusing to stop pid $ProcessId because it is not running $ExpectedScript"
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 100
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
      return
    }
  }
  throw "Timed out while stopping existing controlled watch pid $ProcessId"
}

$scriptRoot = Split-Path -Parent $PSCommandPath
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
}

$serviceDir = Join-Path $RepoRoot ".openclaw\service"
$logDir = Join-Path $RepoRoot ".openclaw\logs"
$pidPath = Join-Path $serviceDir "controlled-task-runner-watch-service.pid"
$statePath = Join-Path $serviceDir "controlled-task-runner-watch-service.json"
$stdoutPath = Join-Path $logDir "controlled-task-runner-watch-service.out.log"
$stderrPath = Join-Path $logDir "controlled-task-runner-watch-service.err.log"
$watchScript = Join-Path $RepoRoot "scripts\openclaw-controlled-task-runner-watch.mjs"
$nodePath = (Get-Command node -ErrorAction Stop).Source

$watchArguments = @(
  $watchScript,
  "--repo-root", $RepoRoot,
  "--interval-ms", "$IntervalMs",
  "--restart-delay-ms", "$RestartDelayMs",
  "--json"
)
if (-not [string]::IsNullOrWhiteSpace($TaskId)) {
  $watchArguments += @("--task", $TaskId)
}
if ($MaxCycles -gt 0) {
  $watchArguments += @("--max-cycles", "$MaxCycles")
}

$launchPlan = @{
  schema = "openclaw.controlled-task-runner-watch-service.v1"
  generatedAt = (Get-Date).ToString("o")
  status = "preview"
  repoRoot = $RepoRoot
  taskId = if ([string]::IsNullOrWhiteSpace($TaskId)) { "auto" } else { $TaskId }
  intervalMs = $IntervalMs
  restartDelayMs = $RestartDelayMs
  maxCycles = $MaxCycles
  nodePath = $nodePath
  watchScript = $watchScript
  arguments = $watchArguments
  pidPath = $pidPath
  stdoutPath = $stdoutPath
  stderrPath = $stderrPath
  nextSafeTask = "Monitor openclaw-controlled-task-runner-watch-latest.json for steady loop health."
}

if (Test-Path -LiteralPath $pidPath) {
  $existingPid = 0
  try {
    $existingPid = [int]((Get-Content -LiteralPath $pidPath -Raw).Trim())
    if ($existingPid -gt 0 -and (Test-ProcessAlive -ProcessId $existingPid)) {
      if (-not (Test-WatchProcess -ProcessId $existingPid -ExpectedScript $watchScript)) {
        throw "Existing pid $existingPid is alive but not running $watchScript"
      }
      if (-not $Force) {
        $launchPlan.status = "running"
        $launchPlan.pid = $existingPid
        $launchPlan.generatedAt = (Get-Date).ToString("o")
        New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $launchJson = $launchPlan | ConvertTo-Json -Depth 6
        Set-Content -LiteralPath $statePath -Value ($launchJson + "`n") -Encoding UTF8
        Write-Output $launchJson
        exit 0
      }
      if (-not $Preview) {
        Stop-WatchProcess -ProcessId $existingPid -ExpectedScript $watchScript
      }
    }
  } catch {
    if ($Force -and -not $Preview -and $existingPid -gt 0 -and (Test-ProcessAlive -ProcessId $existingPid)) {
      throw
    }
    # stale pid or unreadable pid content; continue to relaunch
  }
}

if ($Preview) {
  Write-Output ($launchPlan | ConvertTo-Json -Depth 6)
  exit 0
}

New-Item -ItemType Directory -Path $serviceDir, $logDir -Force | Out-Null

$startProcessArgs = @{
  FilePath = $nodePath
  ArgumentList = $watchArguments
  WorkingDirectory = $RepoRoot
  WindowStyle = "Hidden"
  PassThru = $true
  RedirectStandardOutput = $stdoutPath
  RedirectStandardError = $stderrPath
}

$process = Start-Process @startProcessArgs
Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII
$launchPlan.status = "running"
$launchPlan.pid = $process.Id
$launchPlan.generatedAt = (Get-Date).ToString("o")
$launchJson = $launchPlan | ConvertTo-Json -Depth 6
Set-Content -LiteralPath $statePath -Value ($launchJson + "`n") -Encoding UTF8

Write-Output "CONTROLLED_TASK_RUNNER_WATCH_DAEMON_STARTED pid=$($process.Id)"
