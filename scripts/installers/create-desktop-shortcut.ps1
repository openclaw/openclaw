$ProjectDir = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$LauncherPs1 = Join-Path $ProjectDir "scripts\clawdbot-master.ps1"
$IconPath = Join-Path $ProjectDir "assets\clawdbot.ico"
$DesktopPath = [System.Environment]::GetFolderPath("Desktop")
$PrimaryShortcutPath = Join-Path $DesktopPath "Clawdbot-Master.lnk"
$AliasShortcutNames = @(
    "OpenClaw Desktop Stack.lnk",
    "OpenClaw Launcher.lnk",
    "Hakua.lnk"
)

Write-Host "=== Creating Unified Desktop Shortcuts ===" -ForegroundColor Cyan

$WshShell = New-Object -ComObject WScript.Shell

function Set-Shortcut {
    param(
        [string]$ShortcutPath,
        [string]$Description
    )

    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = "powershell.exe"
    $Shortcut.Arguments = "-ExecutionPolicy Bypass -File `"$LauncherPs1`" -SpeakOnReady"
    $Shortcut.WorkingDirectory = $ProjectDir
    $Shortcut.Description = $Description

    if (Test-Path $IconPath) {
        $Shortcut.IconLocation = "$IconPath,0"
    } else {
        $Shortcut.IconLocation = "powershell.exe,0"
    }

    $Shortcut.WindowStyle = 1
    $Shortcut.Save()
}

Set-Shortcut -ShortcutPath $PrimaryShortcutPath -Description "Launch Clawdbot unified desktop stack"

foreach ($aliasName in $AliasShortcutNames) {
    $aliasPath = Join-Path $DesktopPath $aliasName
    Set-Shortcut -ShortcutPath $aliasPath -Description "Legacy alias for Clawdbot unified desktop stack"
}

Write-Host "[OK] Primary shortcut created: $PrimaryShortcutPath" -ForegroundColor Green
Write-Host "[OK] Legacy desktop aliases updated to the same launcher target." -ForegroundColor Green
Write-Host "Double-click any updated shortcut to start the unified stack." -ForegroundColor Yellow
