$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$scPath = Join-Path $desktop 'OpenClaw Web.lnk'
$sc = $ws.CreateShortcut($scPath)
$sc.TargetPath = 'http://localhost:18789'
$sc.Description = 'OpenClaw Web UI'
$sc.Save()
Write-Host "Shortcut created at: $scPath"
