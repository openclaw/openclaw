<#
.SYNOPSIS
  Clawdbot デスクトップショートカット + スタートアップ Task Scheduler 登録スクリプト
.DESCRIPTION
  1. .ico ファイルを生成 (Python)
  2. デスクトップ上の既存 OpenClaw.lnk / OpenCode.lnk を削除
  3. 新しい「Clawdbot」ショートカットをデスクトップに作成
  4. Windows Task Scheduler にログオン時自動起動タスクを登録
.USAGE
  PowerShell を管理者として実行:
  Set-ExecutionPolicy Bypass -Scope Process -Force
  & "C:\Users\downl\Desktop\clawdbot-main3\clawdbot-main\scripts\setup-autostart.ps1"
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = 'C:\Users\downl\Desktop\clawdbot-main3\clawdbot-main'
$Launcher = Join-Path $RepoRoot 'scripts\launch-clawdbot.ps1'
$Desktop = [Environment]::GetFolderPath('Desktop')
$IcoSrc = Join-Path $RepoRoot 'assets\clawdbot.ico'
$TaskName = 'Clawdbot_AutoStart'

Write-Host "`n🦞 Clawdbot セットアップ開始`n" -ForegroundColor Cyan

# ─── Step 1: .ico 生成 ───────────────────────────────────────
Write-Host "[1/4] ザリガニアイコンを生成中..."
$pyScript = Join-Path $RepoRoot 'scripts\make-icon.py'
try {
    & Py -3 $pyScript
    Write-Host "  ✓ アイコン生成完了" -ForegroundColor Green
}
catch {
    Write-Host "  ⚠ アイコン生成失敗 (Pythonなし?): $_" -ForegroundColor Yellow
    Write-Host "    フォールバック: 既存 favicon.ico を使用します"
    $IcoSrc = Join-Path $RepoRoot 'dist\control-ui\favicon.ico'
}

# ─── Step 2: 既存ショートカット削除 ──────────────────────────
Write-Host "[2/4] 既存ショートカットをクリーンアップ中..."
$oldShortcuts = @('OpenClaw.lnk', 'OpenCode.lnk')
foreach ($old in $oldShortcuts) {
    $path = Join-Path $Desktop $old
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "  削除: $old" -ForegroundColor Gray
    }
}
Write-Host "  ✓ クリーンアップ完了" -ForegroundColor Green

# ─── Step 3: ショートカット作成 ──────────────────────────────
Write-Host "[3/4] 「Clawdbot🦞」ショートカットを作成中..."
$ShortcutPath = Join-Path $Desktop 'Clawdbot🦞.lnk'
$WshShell = New-Object -ComObject WScript.Shell
$sc = $WshShell.CreateShortcut($ShortcutPath)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$Launcher`""
$sc.WorkingDirectory = $RepoRoot
$sc.Description = 'Clawdbot — 自己修復・自己改善・自己増殖エージェント'
$sc.WindowStyle = 7  # 最小化起動
if (Test-Path $IcoSrc) {
    $sc.IconLocation = "$IcoSrc,0"
}
else {
    $sc.IconLocation = 'powershell.exe,0'
}
$sc.Save()
Write-Host "  ✓ ショートカット作成: $ShortcutPath" -ForegroundColor Green

# ─── Step 4: Task Scheduler 登録 ─────────────────────────────
Write-Host "[4/4] Windows Task Scheduler に自動起動タスクを登録中..."

# 既存タスクがあれば削除
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  既存タスク削除: $TaskName" -ForegroundColor Gray
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$Launcher`"" `
    -WorkingDirectory $RepoRoot

# ログオン時起動 (このユーザー)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Clawdbot 自律エージェント (自己修復・自己改善・自己増殖)' `
    -Force | Out-Null

Write-Host "  ✓ タスクスケジューラ登録完了: $TaskName" -ForegroundColor Green

# ─── 完了 ────────────────────────────────────────────────────
Write-Host @"

╔══════════════════════════════════════════════════════╗
║  🦞 Clawdbot セットアップ完了！                       ║
║                                                      ║
║  デスクトップ: Clawdbot🦞.lnk (ザリガニアイコン)      ║
║  自動起動    : ログオン時に自動スタート                   ║
║  今すぐ起動  : ショートカットをダブルクリック              ║
╚══════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

Write-Host "今すぐ起動しますか？ [Y/N] " -NoNewline
$ans = Read-Host
if ($ans -match '^[Yy]') {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$Launcher`""
    Write-Host "  🦞 Clawdbot 起動しました！" -ForegroundColor Green
}
