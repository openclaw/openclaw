$WshShell = New-Object -ComObject WScript.Shell
$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$ScriptPath = Join-Path $RepoRoot "scripts\start-all-in-one.bat"
$DesktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")

$ShortcutPath = Join-Path $DesktopPath "Clawdbot-Launcher.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "C:\Windows\System32\cmd.exe"
$Shortcut.Arguments = "/k `"$ScriptPath`""
$Shortcut.WorkingDirectory = $RepoRoot
$Shortcut.Description = "Clawdbot Unified Launcher"
$IconPath = Join-Path $RepoRoot "assets\clawdbot.ico"
if (Test-Path $IconPath) {
    $Shortcut.IconLocation = "$IconPath,0"
} else {
    $Shortcut.IconLocation = "shell32.dll,248"
}
$Shortcut.Save()

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Shortcut Cleanup Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Removed $removed old shortcuts" -ForegroundColor Yellow
Write-Host "Created unified shortcut: Clawdbot-Launcher.lnk" -ForegroundColor Green
Write-Host ""
Write-Host "Desktop -> Clawdbot-Launcher.lnk" -ForegroundColor White
Write-Host "  Starts: SBV2 + Gateway (port 6000) + Avatar + Browser" -ForegroundColor Gray
