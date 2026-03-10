# Create OpenClaw Browser desktop shortcut
# Launches Chrome with CDP debugging for OpenClaw agent control

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$scPath = Join-Path $desktop 'OpenClaw Browser.lnk'

$userDataDir = Join-Path $env:USERPROFILE '.openclaw\browser\openclaw\user-data'
$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

# Fallback: detect Chrome location
if (-not (Test-Path $chromePath)) {
    $chromePath = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(Default)'
}

if (-not $chromePath -or -not (Test-Path $chromePath)) {
    Write-Error "Chrome not found. Install Chrome or set browser.executablePath in openclaw config."
    exit 1
}

$sc = $ws.CreateShortcut($scPath)
$sc.TargetPath = $chromePath
$sc.Arguments = "--remote-debugging-port=18800 --user-data-dir=`"$userDataDir`" --no-first-run --no-default-browser-check"
$sc.Description = 'OpenClaw Managed Browser (GUI mode)'
$sc.IconLocation = "$chromePath,0"
$sc.Save()

Write-Host "OpenClaw Browser shortcut created at: $scPath"
