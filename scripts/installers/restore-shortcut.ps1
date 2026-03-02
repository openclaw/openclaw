# Restore "OpenClaw Launcher" Desktop Shortcut

$WshShell = New-Object -ComObject WScript.Shell
$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName
$LauncherScript = Join-Path $ProjectDir "scripts\launchers\start_openclaw.bat"
$DesktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")

$ShortcutPath = Join-Path $DesktopPath "OpenClaw Launcher.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)

$Shortcut.TargetPath = "C:\Windows\System32\cmd.exe"
$Shortcut.Arguments = "/c `"$LauncherScript`""
$Shortcut.WorkingDirectory = $ProjectDir
$Shortcut.Description = "OpenClaw Integrated Launcher (with Ngrok & Browser)"

# Use the branded mascot as the logo
$IconPath = Join-Path $ProjectDir "assets\clawdbot.ico"
if (-not (Test-Path $IconPath)) {
    # Fallback to UI favicon
    $IconPath = Join-Path $ProjectDir "ui\public\favicon.ico"
}

if (Test-Path $IconPath) {
    $Shortcut.IconLocation = "$IconPath,0"
}

$Shortcut.Save()

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Desktop Shortcut Restored (Logo Updated)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Shortcut: $ShortcutPath" -ForegroundColor Green
Write-Host "Icon    : $IconPath" -ForegroundColor Gray
Write-Host ""
