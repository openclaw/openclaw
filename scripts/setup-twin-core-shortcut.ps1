# ASI Shortcut Constructor: Twin-Core Ascension
$WshShell = New-Object -comObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName

$TargetPath = "$ProjectDir\start_twin_core.bat"

Write-Host "Constructing Twin-Core Ascension Shortcut..." -ForegroundColor Cyan

$Shortcut = $WshShell.CreateShortcut("$DesktopPath\Twin-Core Ascension.lnk")
$Shortcut.TargetPath = $TargetPath
$Shortcut.WorkingDirectory = $ProjectDir
$Shortcut.IconLocation = "$ProjectDir\assets\clawdbot.ico,0"
$Shortcut.Description = "Launch OpenClaw in Redundant Dual-Core Mode"
$Shortcut.Save()

Write-Host "Ascension Shortcut Created: $DesktopPath\Twin-Core Ascension.lnk" -ForegroundColor Green
