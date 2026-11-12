#!/usr/bin/env pwsh
<#
.SYNOPSIS
Measures one cold Gateway start on native Windows.

.DESCRIPTION
Runs either the packaged entry or the raw watch entry against an isolated state
directory and port, waits for /readyz, samples RSS, parses startup/stall logs, and
writes a JSON record. The script never touches the caller's OpenClaw state.
#>
[CmdletBinding()]
param(
  [ValidateSet("dist", "watch-raw")]
  [string]$Mode = "dist",
  [int]$Port = 18999,
  [int]$TimeoutSec = 120,
  [string]$Out = ".artifacts/bench/startup.json",
  [string]$ConfigPath = "",
  [switch]$KeepState
)

$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$benchRoot = Join-Path $root ".artifacts\bench"
$stateDir = Join-Path $benchRoot "state-$Mode-$stamp"
$logPath = Join-Path $benchRoot "startup-$Mode-$stamp.out.log"
$errPath = Join-Path $benchRoot "startup-$Mode-$stamp.err.log"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
New-Item -ItemType Directory -Path $benchRoot -Force | Out-Null

$env:OPENCLAW_STATE_DIR = $stateDir
$env:OPENCLAW_CONFIG_PATH = Join-Path $stateDir "openclaw.json"
if ($ConfigPath) {
  Copy-Item -LiteralPath $ConfigPath -Destination $env:OPENCLAW_CONFIG_PATH -Force
} elseif (-not (Test-Path -LiteralPath $env:OPENCLAW_CONFIG_PATH)) {
  @{ gateway = @{ mode = "local"; port = $Port } } |
    ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath $env:OPENCLAW_CONFIG_PATH -Encoding UTF8
}
$env:OPENCLAW_GATEWAY_PORT = [string]$Port
$env:OPENCLAW_GATEWAY_STARTUP_TRACE = "1"
$env:OPENCLAW_SKIP_CHANNELS = "1"
$env:OPENCLAW_LOG_LEVEL = "info"
$env:NO_COLOR = "1"

$node = (Get-Command node -ErrorAction Stop).Source
$arguments = if ($Mode -eq "dist") {
  @("dist/index.js", "gateway", "run")
} else {
  @("scripts/watch-node.mjs", "gateway", "--force")
}

$process = Start-Process -FilePath $node -ArgumentList $arguments -PassThru `
  -RedirectStandardOutput $logPath -RedirectStandardError $errPath -NoNewWindow
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$readyAtMs = $null
$rssSamples = New-Object System.Collections.Generic.List[int]
$readyUrl = "http://127.0.0.1:$Port/readyz"
$sampled = $false

try {
  while ($watch.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if ($process.HasExited) { break }
    if (-not $sampled) {
      try {
        $current = Get-Process -Id $process.Id -ErrorAction Stop
        $rssSamples.Add([int]$current.WorkingSet64)
      } catch {}
    }
    if ($null -eq $readyAtMs) {
      try {
        $response = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
          $readyAtMs = [int]$watch.ElapsedMilliseconds
        }
      } catch {}
    }
    if ($null -ne $readyAtMs -and $rssSamples.Count -ge 8) { break }
    Start-Sleep -Milliseconds 100
  }
} finally {
  $watch.Stop()
  if (-not $process.HasExited) {
    & taskkill /PID $process.Id /T /F 2>$null | Out-Null
  }
  $process.WaitForExit(10000) | Out-Null
}

$log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
$err = if (Test-Path -LiteralPath $errPath) { Get-Content -LiteralPath $errPath -Raw } else { "" }
$combined = "$log`n$err"
$stalls = [regex]::Matches($combined, 'main-thread stall: elapsedMs=(\d+)') |
  ForEach-Object { [int]$_.Groups[1].Value }
$rssLog = [regex]::Matches($combined, 'rssMb=([0-9.]+)') |
  ForEach-Object { [double]$_.Groups[1].Value }
$maxRssMb = if ($rssLog.Count -gt 0) { ($rssLog | Measure-Object -Maximum).Maximum } else { $null }
$maxStallMs = if ($stalls.Count -gt 0) { ($stalls | Measure-Object -Maximum).Maximum } else { $null }
$maxSampleMb = if ($rssSamples.Count -gt 0) {
  [math]::Round((($rssSamples | Measure-Object -Maximum).Maximum / 1MB), 1)
} else { $null }

$record = [ordered]@{
  schema = 1
  capturedAt = (Get-Date).ToString("o")
  mode = $Mode
  argv = $arguments -join " "
  node = (& node --version)
  port = $Port
  stateDir = $stateDir
  buildInfo = if (Test-Path (Join-Path $root "dist\build-info.json")) {
    Get-Content (Join-Path $root "dist\build-info.json") -Raw | ConvertFrom-Json
  } else { $null }
  readyMs = $readyAtMs
  exited = $process.HasExited
  exitCode = if ($process.HasExited) { $process.ExitCode } else { $null }
  sampledRssMbMax = $maxSampleMb
  logRssMbMax = $maxRssMb
  stallMsMax = $maxStallMs
  stallCount = $stalls.Count
  logPath = $logPath
  errPath = $errPath
}
New-Item -ItemType Directory -Path (Split-Path -Parent $Out) -Force | Out-Null
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Out -Encoding UTF8
$record | ConvertTo-Json -Depth 8
if (-not $KeepState) {
  Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}
