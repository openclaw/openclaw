<#
.SYNOPSIS
  永不卡住引擎一鍵自舉：驗證引擎本體 → 背景常駐啟動 → 可選開機自啟。
  「插電」一次，之後對話無關全自動。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openclaw-never-stuck-bootstrap.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/openclaw-never-stuck-bootstrap.ps1 -RegisterStartup
#>
param([string]$RepoRoot = "", [switch]$RegisterStartup)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
Set-Location $RepoRoot

Write-Host "== 1/2 驗證引擎本體（worktree-pool + dev-task-runner）=="
pnpm exec vitest run src/agents/git-worktree-pool
if ($LASTEXITCODE -ne 0) { throw "worktree-pool 測試未過，中止自舉" }
pnpm exec vitest run src/agents/dev-task-runner
if ($LASTEXITCODE -ne 0) { throw "dev-task-runner 測試未過，中止自舉" }

Write-Host "== 2/2 背景啟動執行器（verify-only；executor/notifyApproval 待 Codex 接上後升級為自動寫碼）=="
$launch = Join-Path $PSScriptRoot "openclaw-dev-task-runner-launch.ps1"
$psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launch)
if ($RegisterStartup) { $psArgs += "-RegisterStartup" }
powershell @psArgs

Write-Host "`n[OK] 引擎已常駐（對話無關）。"
Write-Host "下一步：在本機 Codex 執行 CODEX_TASK_never-stuck-runtime.md，接上 executor(runCliAgent)/notifyApproval(confirm gate)，即升級為自動寫碼閉環。"
