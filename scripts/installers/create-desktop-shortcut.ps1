# デスクトップにOpenClawブラウザショートカットを作成するインストーラー
# 一度実行するだけでOKです。

$ProjectDir  = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$LauncherPs1 = Join-Path $ProjectDir "scripts\launchers\launch-with-browser.ps1"
$DesktopPath = [System.Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "OpenClaw.lnk"

Write-Host "=== OpenClaw デスクトップショートカット作成 ===" -ForegroundColor Cyan

# ショートカット作成
$WshShell   = New-Object -ComObject WScript.Shell
$Shortcut   = $WshShell.CreateShortcut($ShortcutPath)

# ダブルクリックで PowerShell を非表示なし（コンソール表示）で起動
$Shortcut.TargetPath       = "powershell.exe"
$Shortcut.Arguments        = "-ExecutionPolicy Bypass -File `"$LauncherPs1`""
$Shortcut.WorkingDirectory = $ProjectDir
$Shortcut.Description      = "OpenClaw を起動してブラウザで開く"

# アイコン — Edge の msedge.exe から流用（存在すれば）
$EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (Test-Path $EdgePath) {
    $Shortcut.IconLocation = "$EdgePath,0"
} else {
    $Shortcut.IconLocation = "powershell.exe,0"
}

# WindowStyle 1 = 通常ウィンドウ
$Shortcut.WindowStyle = 1
$Shortcut.Save()

Write-Host "[OK] ショートカットを作成しました: $ShortcutPath" -ForegroundColor Green
Write-Host ""
Write-Host "使い方:" -ForegroundColor Yellow
Write-Host "  デスクトップの [OpenClaw] をダブルクリックするだけです。"
Write-Host "  サーバーが起動し、準備完了後にブラウザが自動で開きます。"
Write-Host ""
