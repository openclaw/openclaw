param(
  [string]$UsbRoot,

  [string]$ConfigRoot,

  [ValidateSet("init", "run", "status")]
  [string]$Action = "run",

  [ValidateSet("native", "wsl")]
  [string]$Mode = "native",

  [string]$Distro = "Ubuntu"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($UsbRoot)) {
  $UsbRoot = Join-Path $ScriptDir "data"
}

if ($Mode -eq "native") {
  $NativeScript = Join-Path $ScriptDir "usb-openclaw-win-native.ps1"
  if (-not (Test-Path $NativeScript)) {
    throw "Missing script: $NativeScript"
  }
  $argsMap = @{ Action = $Action }
  if (-not [string]::IsNullOrWhiteSpace($UsbRoot)) {
    $argsMap["UsbRoot"] = $UsbRoot
  }
  if (-not [string]::IsNullOrWhiteSpace($ConfigRoot)) {
    $argsMap["ConfigRoot"] = $ConfigRoot
  }
  & $NativeScript @argsMap
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
  exit 0
}

function Ensure-WSL {
  try {
    wsl --status | Out-Null
    return
  }
  catch {
    Write-Host "[bootstrap] WSL not ready. Trying to install WSL + Ubuntu..."
    wsl --install -d $Distro
    Write-Host "[next] WSL install triggered. If prompted for reboot/user creation, finish that first, then re-run this command."
    exit 1
  }
}

Ensure-WSL

$WslScriptWin = Join-Path $ScriptDir "usb-openclaw-wsl.sh"

if (-not (Test-Path $WslScriptWin)) {
  throw "Missing script: $WslScriptWin"
}

$WslUsbRoot = (wsl wslpath -a "$UsbRoot").Trim()
$WslScript = (wsl wslpath -a "$WslScriptWin").Trim()
$WslConfigRoot = ""
if (-not [string]::IsNullOrWhiteSpace($ConfigRoot)) {
  $WslConfigRoot = (wsl wslpath -a "$ConfigRoot").Trim()
}

Write-Host "[info] Distro: $Distro"
Write-Host "[info] USB root (Windows): $UsbRoot"
Write-Host "[info] USB root (WSL): $WslUsbRoot"
Write-Host "[info] WSL script: $WslScript"
if ($WslConfigRoot) {
  Write-Host "[info] Config root (WSL): $WslConfigRoot"
}

wsl -d $Distro -- chmod +x "$WslScript"
if ($WslConfigRoot) {
  wsl -d $Distro -- env OPENCLAW_CONFIG_ROOT="$WslConfigRoot" bash "$WslScript" "$Action" "$WslUsbRoot"
}
else {
  wsl -d $Distro -- bash "$WslScript" "$Action" "$WslUsbRoot"
}
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
