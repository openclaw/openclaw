#Requires -Version 5.1

param(
    [switch]$Uninstall,
    [switch]$Silent,
    [string]$InstallPath = "$env:ProgramFiles\OpenClaw"
)

# 0. Admin & Context Check
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Administrator privileges required. Relaunching..." -ForegroundColor Yellow
    $arguments = "-ExecutionPolicy Bypass -File `"$($myinvocation.mycommand.definition)`""
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
            & $officialScript -Uninstall
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
    Remove-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" -Name "OpenClaw" -ErrorAction SilentlyContinue
    
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
if (-not $vcReg -or $vcReg.Version -lt "v14.30") {
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
# Priority: 1. Exact binary name, 2. Build output in release folder, 3. Anything that isn't a Setup installer
$srcExe = Get-Item -Path (Join-Path $PSScriptRoot "OpenClaw.exe") -ErrorAction SilentlyContinue
if (-not $srcExe) {
    $srcExe = Get-Item -Path (Join-Path $PSScriptRoot "..\..\apps\windows\src-tauri\target\release\OpenClaw.exe") -ErrorAction SilentlyContinue
}
if (-not $srcExe) {
    # Fallback to any .exe that doesn't look like a setup/bundle (Wildcard exclusion for typical Tauri setup names)
    $srcExe = Get-ChildItem -Path $PSScriptRoot -Filter "*.exe" | Where-Object { $_.Name -notlike "OpenClaw_*_setup.exe" -and $_.Name -notlike "OpenClaw_*_x64*" } | Select-Object -First 1
}

if (-not $srcExe) {
    Write-Host "ERROR: OpenClaw application binary (OpenClaw.exe) not found." -ForegroundColor Red
    Write-Host "Please ensure you have built the project (pnpm build) or placed the binary in $PSScriptRoot." -ForegroundColor Gray
    exit 1
}
New-Item -ItemType Directory -Force -Path $InstallPath | Out-Null
Copy-Item $srcExe.FullName -Destination (Join-Path $InstallPath "OpenClaw.exe") -Force

# Persistent Uninstaller
$UninstallerTarget = Join-Path $InstallPath "uninstall.ps1"
Copy-Item $PSCommandPath $UninstallerTarget -Force

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
$RunPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
Set-ItemProperty -Path $RunPath -Name "OpenClaw" -Value "`"$ExePath`""

# 7. Firewall Rules
Write-Step "Configuring Windows Firewall for OpenClaw Gateway..."
New-NetFirewallRule -DisplayName "OpenClaw Gateway" -Direction Inbound -LocalPort 18789 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName "OpenClaw Gateway" -Direction Outbound -LocalPort 18789 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

Write-Host "`nOpenClaw installation complete! Launch it from your desktop." -ForegroundColor Green
