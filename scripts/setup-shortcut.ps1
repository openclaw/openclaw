$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName
$LauncherPs1 = Join-Path $ProjectDir "scripts\clawdbot-master.ps1"
$IconPath = Join-Path $ProjectDir "assets\clawdbot.ico"
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")

$OldShortcut = Join-Path $DesktopPath "Hakua Link.lnk"
if (Test-Path $OldShortcut) {
    Remove-Item $OldShortcut -Force
}

$ShortcutPath = Join-Path $DesktopPath "Hakua.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-ExecutionPolicy Bypass -File `"$LauncherPs1`" -SpeakOnReady"
$Shortcut.WorkingDirectory = $ProjectDir
$Shortcut.IconLocation = if (Test-Path $IconPath) { "$IconPath,0" } else { "powershell.exe,0" }
$Shortcut.Description = "Legacy alias for Clawdbot unified desktop stack"
$Shortcut.Save()

Write-Host "Updated 'Hakua.lnk' to the unified launcher." -ForegroundColor Green
