$WshShell = New-Object -comObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$StartupPath = [Environment]::GetFolderPath('Startup')

$TargetPath = "c:\Users\downl\Desktop\clawdbot-main3\clawdbot-main\start_openclaw.bat"

$Shortcut = $WshShell.CreateShortcut("$DesktopPath\OpenClaw.lnk")
$Shortcut.TargetPath = $TargetPath
$Shortcut.WorkingDirectory = "c:\Users\downl\Desktop\clawdbot-main3\clawdbot-main"
$Shortcut.Save()
Write-Host "Created Desktop shortcut: $DesktopPath\OpenClaw.lnk"

$StartupShortcut = $WshShell.CreateShortcut("$StartupPath\OpenClaw.lnk")
$StartupShortcut.TargetPath = $TargetPath
$StartupShortcut.WorkingDirectory = "c:\Users\downl\Desktop\clawdbot-main3\clawdbot-main"
$StartupShortcut.Save()
Write-Host "Created Startup shortcut: $StartupPath\OpenClaw.lnk"
