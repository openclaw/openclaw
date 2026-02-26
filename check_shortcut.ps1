$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut('C:\Users\downl\Desktop\desktopzen2026-02-22\Clawdbot-Launcher.lnk')
Write-Host "Target: $($lnk.TargetPath)"
Write-Host "Args: $($lnk.Arguments)"
