$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$scPath = Join-Path $desktop 'OpenClaw Browser.lnk'
$sc = $ws.CreateShortcut($scPath)
$sc.TargetPath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$sc.Arguments = '--remote-debugging-port=18800 --user-data-dir="C:\Users\jini9\.openclaw\browser\openclaw\user-data" --no-first-run --no-default-browser-check'
$sc.Description = 'OpenClaw Managed Browser (GUI mode)'
$sc.IconLocation = 'C:\Program Files\Google\Chrome\Application\chrome.exe,0'
$sc.Save()
Write-Host "Shortcut created at: $scPath"
