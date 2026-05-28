<#
.SYNOPSIS
  dev-task 執行器常駐自啟（永不卡住・對話無關 L1 引擎）。
.DESCRIPTION
  背景常駐啟動執行器；防重複啟動；可選註冊 Windows 登入自啟（一次性，之後自動常駐）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openclaw-dev-task-runner-launch.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openclaw-dev-task-runner-launch.ps1 -RegisterStartup
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openclaw-dev-task-runner-launch.ps1 -Preview
#>
param(
  [string]$RepoRoot = "",
  [int]$IntervalMs = 5000,
  [switch]$Preview,
  [switch]$RegisterStartup
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# repo 根：預設 = 本腳本上層目錄
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$entry = Join-Path $RepoRoot "scripts/openclaw-dev-task-runner.ts"
if (-not (Test-Path $entry)) { throw "找不到入口：$entry" }

# 防重複：查是否已有同一執行器在跑（複用 watch-launch 的 CommandLine 偵測模式）
$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*openclaw-dev-task-runner.ts*" }
if ($running) {
  $pids = ($running.ProcessId) -join ","
  Write-Host "[dev-task-runner] 已在執行（PID=$pids），不重複啟動。"
  return
}

$nodeArgs = @("--import", "tsx", $entry, "--repo-root", $RepoRoot, "--interval-ms", "$IntervalMs")
if ($Preview) {
  Write-Host "[dev-task-runner] Preview：node $($nodeArgs -join ' ')"
  return
}

# 一次性註冊登入自啟；之後登入自動常駐（對話無關）
if ($RegisterStartup) {
  $self = $MyInvocation.MyCommand.Path
  $action = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`""
  schtasks /Create /TN "OpenClawDevTaskRunner" /TR $action /SC ONLOGON /RL LIMITED /F | Out-Null
  Write-Host "[dev-task-runner] 已註冊登入自啟（工作排程器：OpenClawDevTaskRunner）。"
}

# 背景常駐啟動
Start-Process -FilePath "node" -ArgumentList $nodeArgs -WorkingDirectory $RepoRoot -WindowStyle Hidden
Write-Host "[dev-task-runner] 已背景啟動：repoRoot=$RepoRoot interval=$IntervalMs ms"
