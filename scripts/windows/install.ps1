#Requires -Version 5.1

param(
    [switch]$Uninstall,
    [switch]$Silent,
    [string]$InstallPath = "$env:ProgramFiles\OpenClaw"
)

# 0. Admin & Context Check
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Administrator privileges required. Relaunching..." -ForegroundColor Yellow
    
    $scriptPath = $MyInvocation.MyCommand.Path
    if (-not $scriptPath) {
        # Running via IEX (no file path). Save content to a temp file to allow -File relaunch.
        $scriptPath = Join-Path $env:TEMP "install_openclaw.ps1"
        $MyInvocation.MyCommand.Definition | Out-File -FilePath $scriptPath -Encoding utf8
    }

    $arguments = "-ExecutionPolicy Bypass -File `"$scriptPath`""
    if ($Uninstall) { $arguments += " -Uninstall" }
    if ($Silent) { $arguments += " -Silent" }
    $arguments += " -InstallPath `"$InstallPath`""
    Start-Process powershell -Verb RunAs -ArgumentList $arguments
    exit
}

# Self-Delegation for Uninstallation
if ($Uninstall) {
    if ($PSScriptRoot -ne $InstallPath) {
        $officialScript = Join-Path $InstallPath "uninstall.ps1"
        if (Test-Path $officialScript) {
            Write-Host "Delegating uninstallation to the official script..." -ForegroundColor Cyan
            & $officialScript -Uninstall -InstallPath $InstallPath
            exit
        }
    }
    
    Write-Host "Uninstalling OpenClaw..." -ForegroundColor Red
    $exePath = Join-Path $InstallPath "OpenClaw.exe"
    
    # Stop processes
    Get-Process | Where-Object {$_.Path -like "*openclaw*"} | Stop-Process -Force -ErrorAction SilentlyContinue
    
    # AppData cleanup via CLI
    if (Test-Path $exePath) {
        & $exePath "--uninstall"
    }
    
    # Remove Files
    Remove-Item $InstallPath -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:LOCALAPPDATA\OpenClaw" -Recurse -Force -ErrorAction SilentlyContinue
    
    # Remove Registry
    Remove-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\OpenClaw" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name "OpenClaw" -ErrorAction SilentlyContinue
    
    # Remove Firewall
    Remove-NetFirewallRule -DisplayName "OpenClaw Gateway" -ErrorAction SilentlyContinue
    
    Write-Host "OpenClaw has been successfully removed." -ForegroundColor Green
    exit
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host " OK $msg" -ForegroundColor Green }

# 1. Prerequisites (VC++, WebView2, Node.js)
Write-Step "Checking prerequisites..."
$vcReg = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" -ErrorAction SilentlyContinue
if ($vcReg) {
    $currentVersion = [version]($vcReg.Version -replace 'v', '')
    $minVersion = [version]("14.30")
    if ($currentVersion -lt $minVersion) {
        $shouldInstallVC = $true
    }
} else {
    $shouldInstallVC = $true
}

if ($shouldInstallVC) {
    Write-Step "Installing VC++ Redistributable (x64)..."
    $url = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
    $output = "$env:TEMP\vc_redist.x64.exe"
    Invoke-WebRequest -Uri $url -OutFile $output
    Start-Process -FilePath $output -ArgumentList "/install /quiet /norestart" -Wait
}

$wv2 = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if (-not $wv2) {
    $url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    $output = "$env:TEMP\MicrosoftEdgeWebview2Setup.exe"
    Invoke-WebRequest -Uri $url -OutFile $output
    Start-Process -FilePath $output -ArgumentList "/silent /install" -Wait
}

# 2. Tools (Node.js & OpenClaw CLI)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    winget install OpenJS.NodeJS.LTS --silent
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    & "$env:ProgramFiles\nodejs\npm.cmd" install -g openclaw@latest
} else {
    npm install -g openclaw@latest
}

# 3. Installation
Write-Step "Installing files to $InstallPath..."

# Build the candidate list for the source binary
$srcExe = Get-Item -Path (Join-Path $PSScriptRoot "OpenClaw.exe") -ErrorAction SilentlyContinue
if (-not $srcExe) { $srcExe = Get-Item -Path (Join-Path $PSScriptRoot "openclaw-desktop.exe") -ErrorAction SilentlyContinue }
if (-not $srcExe) { $srcExe = Get-Item -Path (Join-Path $PSScriptRoot "..\..\apps\windows\src-tauri\target\release\openclaw-desktop.exe") -ErrorAction SilentlyContinue }

# NEW: Automatic remote download if no local binary is found
if (-not $srcExe) {
    Write-Host "" -ForegroundColor Red
    Write-Host "ERROR: OpenClaw desktop binary not found locally." -ForegroundColor Red
    Write-Host "" 
    Write-Host "To install the OpenClaw desktop app, either:" -ForegroundColor Yellow
    Write-Host "  1. Build it locally:  pnpm install && pnpm tauri build" -ForegroundColor Gray
    Write-Host "     Then re-run this script from: apps/windows/src-tauri/target/release/" -ForegroundColor Gray
    Write-Host "  2. Download a pre-built release from the project releases page." -ForegroundColor Gray
    Write-Host ""
    Write-Host "Note: The OpenClaw CLI is already installed via npm (openclaw command)." -ForegroundColor Cyan
    exit 1
}


New-Item -ItemType Directory -Force -Path $InstallPath | Out-Null
Copy-Item $srcExe.FullName -Destination (Join-Path $InstallPath "OpenClaw.exe") -Force

# Copy Sidecars/Binaries if present
$srcBinDir = Join-Path $srcExe.Directory.FullName "binaries"
$destBinDir = Join-Path $InstallPath "binaries"
if (Test-Path $srcBinDir) {
    Write-Step "Copying sidecar binaries..."
    Copy-Item $srcBinDir -Destination $destBinDir -Recurse -Force
}

# Persistent Uninstaller
$UninstallerTarget = Join-Path $InstallPath "uninstall.ps1"
if ($PSCommandPath) {
    Copy-Item $PSCommandPath $UninstallerTarget -Force
} else {
    # Running via IEX (no command path). Persist the in-memory script content.
    $MyInvocation.MyCommand.Definition | Out-File -FilePath $UninstallerTarget -Encoding utf8
}

# 4. Shortcuts
$ExePath  = Join-Path $InstallPath "OpenClaw.exe"
$Desktop  = [Environment]::GetFolderPath("Desktop")
if (Test-Path $ExePath) {
    $WScript = New-Object -ComObject WScript.Shell
    $Shortcut = $WScript.CreateShortcut("$Desktop\OpenClaw.lnk")
    $Shortcut.TargetPath = $ExePath
    $Shortcut.IconLocation = "$ExePath,0"
    $Shortcut.Save()
}

# 5. Registry (Add/Remove Programs)
Write-Step "Registering application..."
$RegPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\OpenClaw"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty $RegPath "DisplayName"     "OpenClaw Gateway"
Set-ItemProperty $RegPath "DisplayVersion"  "1.0.0"
Set-ItemProperty $RegPath "Publisher"       "OpenClaw Project"
Set-ItemProperty $RegPath "InstallLocation" $InstallPath
Set-ItemProperty $RegPath "DisplayIcon"     $ExePath
Set-ItemProperty $RegPath "UninstallString" "powershell.exe -ExecutionPolicy Bypass -File `"$UninstallerTarget`" -Uninstall -InstallPath `"$InstallPath`""
Write-OK "Registry updated."

# 6. Autostart
$RunPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
Set-ItemProperty -Path $RunPath -Name "OpenClaw" -Value "`"$ExePath`""

# 7. Firewall Rules
Write-Step "Configuring Hardened Windows Firewall for OpenClaw Gateway..."
$SidecarPath = Get-ChildItem -Path "$InstallPath\binaries" -Filter "openclaw-*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$FirewallProgram = if ($SidecarPath) { $SidecarPath.FullName } else { $ExePath }

# Inbound Rule
$inboundArgs = @{
    DisplayName = "OpenClaw Gateway"
    Direction   = "Inbound"
    LocalPort   = 18789
    Protocol    = "TCP"
    Action      = "Allow"
    ErrorAction = "SilentlyContinue"
}
if ($SidecarPath) { $inboundArgs["Program"] = $SidecarPath.FullName }
New-NetFirewallRule @inboundArgs | Out-Null

# Outbound Rule
$outboundArgs = @{
    DisplayName = "OpenClaw Gateway"
    Direction   = "Outbound"
    LocalPort   = 18789
    Protocol    = "TCP"
    Action      = "Allow"
    ErrorAction = "SilentlyContinue"
}
if ($SidecarPath) { $outboundArgs["Program"] = $SidecarPath.FullName }
New-NetFirewallRule @outboundArgs | Out-Null

Write-Host "`nOpenClaw installation complete! Launch it from your desktop." -ForegroundColor Green
