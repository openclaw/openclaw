# OpenClaw Installer for Windows (PowerShell)
# Usage: iwr -useb https://openclaw.ai/install.ps1 | iex
# Or: & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard

param(
    [string]$InstallMethod = "npm",
    [string]$Tag = "latest",
    [string]$GitDir = "$env:USERPROFILE\openclaw",
    [switch]$NoOnboard,
    [switch]$NoGitUpdate,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Colors
$ACCENT = "`e[38;2;255;77;77m"    # coral-bright
$SUCCESS = "`e[38;2;0;229;204m"    # cyan-bright
$WARN = "`e[38;2;255;176;32m"     # amber
$ERROR_COLOR = "`e[38;2;230;57;70m"     # coral-mid
$MUTED = "`e[38;2;90;100;128m"    # text-muted
$NC = "`e[0m"                     # No Color

function Write-Host {
    param([string]$Message, [string]$Level = "info")
    $msg = switch ($Level) {
        "success" { "$SUCCESS[OK]$NC $Message" }
        "warn" { "$WARN!$NC $Message" }
        "error" { "$ERROR_COLOR[X]$NC $Message" }
        default { "$MUTED[i]$NC $Message" }
    }
    Microsoft.PowerShell.Utility\Write-Host $msg
}

function Write-Banner {
    Write-Host ""
    Write-Host "${ACCENT}  OpenClaw Installer$NC" -Level info
    Write-Host "${MUTED}  All your chats, one OpenClaw.$NC" -Level info
    Write-Host ""
}

function Get-ExecutionPolicyStatus {
    $policy = Get-ExecutionPolicy
    if ($policy -eq "Restricted" -or $policy -eq "AllSigned") {
        return @{ Blocked = $true; Policy = $policy }
    }
    return @{ Blocked = $false; Policy = $policy }
}

function Test-Admin {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-ExecutionPolicy {
    $status = Get-ExecutionPolicyStatus
    if ($status.Blocked) {
        Write-Host "PowerShell execution policy is set to: $($status.Policy)" -Level warn
        Write-Host "This prevents scripts like npm.ps1 from running." -Level warn
        Write-Host ""
        
        # Try to set execution policy for current process
        try {
            Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -ErrorAction Stop
            Write-Host "Set execution policy to RemoteSigned for current process" -Level success
            return $true
        } catch {
            Write-Host "Could not automatically set execution policy" -Level error
            Write-Host ""
            Write-Host "To fix this, run:" -Level info
            Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process" -Level info
            Write-Host ""
            Write-Host "Or run PowerShell as Administrator and execute:" -Level info
            Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine" -Level info
            return $false
        }
    }
    return $true
}

function Get-NodeVersion {
    try {
        $version = node --version 2>$null
        if ($version) {
            return $version -replace '^v', ''
        }
    } catch { }
    return $null
}

function Get-NpmVersion {
    try {
        $version = npm --version 2>$null
        if ($version) {
            return $version
        }
    } catch { }
    return $null
}

function Refresh-ProcessPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @($machinePath, $userPath) | Where-Object { $_ -and $_.Trim() }
    if ($parts.Count -gt 0) {
        $env:Path = ($parts -join ";")
    }
}

function Invoke-ExternalCommand {
    param(
        [string]$File,
        [string[]]$Arguments = @()
    )

    try {
        $output = & $File @Arguments 2>&1
        $text = ($output | Out-String).Trim()
        $code = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }
        return @{
            Ok = ($code -eq 0)
            Code = $code
            Text = $text
        }
    } catch {
        return @{
            Ok = $false
            Code = 1
            Text = (($_ | Out-String).Trim())
        }
    }
}

function Write-WindowsPathChoiceNote {
    Write-Host "Windows setup options:" -Level info
    Write-Host "  Recommended: WSL2 for the most predictable Gateway + service behavior." -Level info
    Write-Host "  Supported: native Windows for CLI use, gateway control, and the Windows tray companion." -Level info
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        Write-Host "  WSL2 detected. Full docs: https://docs.openclaw.ai/platforms/windows" -Level success
    } else {
        Write-Host "  WSL2 is not installed. Quick setup: wsl --install (then reboot Windows)." -Level warn
    }
}

function Ensure-NpmAccess {
    $npmVersion = Get-NpmVersion
    if ($npmVersion) {
        Write-Host "npm v$npmVersion found" -Level success
        return $true
    }

    Write-Host "npm is not available in this PowerShell session." -Level error
    Write-Host "What happened: Node.js may be installed, but npm is missing from PATH or blocked in this shell." -Level warn
    Write-Host "Next step: refresh PATH, open a new PowerShell session, then rerun the installer." -Level info
    Write-Host "If execution policy is the blocker, run: Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process" -Level info
    return $false
}

function Write-InstallFailureGuidance {
    param(
        [string]$Tool,
        [string]$Output
    )

    $detail = ($Output ?? "").Trim()
    Write-Host "$Tool failed" -Level error
    if ($detail) {
        Write-Host "Details: $detail" -Level warn
    }

    if ($detail -match "EPERM|EBUSY|access is denied|being used by another process|resource busy") {
        Write-Host "Likely cause: a file lock, antivirus scan, or another shell/process is holding the OpenClaw install path." -Level warn
        Write-Host "Next step: close other terminals/editors using OpenClaw, wait a few seconds, then rerun the installer." -Level info
        Write-Host "If it keeps happening, restart PowerShell or Windows and retry." -Level info
        return
    }

    if ($detail -match "EEXIST|already exists") {
        Write-Host "Likely cause: an older openclaw shim already exists in your global npm bin directory." -Level warn
        Write-Host "Next step: remove the conflicting file from your npm global prefix, then rerun the installer." -Level info
        return
    }

    if ($detail -match "running scripts is disabled|ExecutionPolicy") {
        Write-Host "Likely cause: PowerShell execution policy is blocking npm's PowerShell wrappers." -Level warn
        Write-Host "Next step: run Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process, then rerun the installer." -Level info
        return
    }

    if ($detail -match "not recognized as the name of a cmdlet|could not find|cannot find") {
        Write-Host "Likely cause: PATH is stale in this PowerShell session." -Level warn
        Write-Host "Next step: open a fresh PowerShell window and rerun the installer." -Level info
        return
    }

    Write-Host "Next step: fix the error above, then rerun the installer. Windows troubleshooting: https://docs.openclaw.ai/platforms/windows-troubleshooting" -Level info
}

function Resolve-OpenClawCommand {
    foreach ($candidate in @("openclaw.cmd", "openclaw")) {
        try {
            $command = Get-Command $candidate -ErrorAction Stop | Select-Object -First 1
            if ($command.Source) {
                return $command.Source
            }
        } catch { }
    }

    try {
        $npmPrefix = npm config get prefix 2>$null
        foreach ($candidate in @("$npmPrefix\\openclaw.cmd", "$npmPrefix\\openclaw")) {
            if ($candidate -and (Test-Path $candidate)) {
                return $candidate
            }
        }
    } catch { }

    return $null
}

function Verify-OpenClawInstall {
    $commandPath = Resolve-OpenClawCommand
    if (-not $commandPath) {
        Write-Host "OpenClaw was installed, but the command is not visible in this PowerShell session." -Level warn
        Write-Host "Next step: open a fresh PowerShell window and run 'openclaw --version'." -Level info
        return $false
    }

    $result = Invoke-ExternalCommand -File $commandPath -Arguments @("--version")
    if ($result.Ok -and $result.Text) {
        Write-Host "Verified OpenClaw CLI: $($result.Text)" -Level success
        return $true
    }

    Write-Host "OpenClaw install completed, but post-install verification failed." -Level error
    Write-InstallFailureGuidance -Tool "openclaw --version" -Output $result.Text
    return $false
}

function Install-Node {
    Write-Host "Node.js not found" -Level info
    Write-Host "Installing Node.js..." -Level info
    
    # Try winget first
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  Using winget..." -Level info
        try {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
            Refresh-ProcessPath
            Write-Host "  Node.js installed via winget" -Level success
            return $true
        } catch {
            Write-Host "  Winget install failed: $_" -Level warn
        }
    }
    
    # Try chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Host "  Using chocolatey..." -Level info
        try {
            choco install nodejs-lts -y 2>&1 | Out-Null
            Refresh-ProcessPath
            Write-Host "  Node.js installed via chocolatey" -Level success
            return $true
        } catch {
            Write-Host "  Chocolatey install failed: $_" -Level warn
        }
    }
    
    # Try scoop
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Host "  Using scoop..." -Level info
        try {
            scoop install nodejs-lts 2>&1 | Out-Null
            Refresh-ProcessPath
            Write-Host "  Node.js installed via scoop" -Level success
            return $true
        } catch {
            Write-Host "  Scoop install failed: $_" -Level warn
        }
    }
    
    Write-Host "Could not install Node.js automatically" -Level error
    Write-Host "Please install Node.js 22+ manually from: https://nodejs.org" -Level info
    return $false
}

function Ensure-Node {
    $nodeVersion = Get-NodeVersion
    if ($nodeVersion) {
        $major = [int]($nodeVersion -split '\.')[0]
        if ($major -ge 22) {
            Write-Host "Node.js v$nodeVersion found" -Level success
            return $true
        }
        Write-Host "Node.js v$nodeVersion found, but need v22+" -Level warn
    }
    return Install-Node
}

function Get-GitVersion {
    try {
        $version = git --version 2>$null
        if ($version) {
            return $version
        }
    } catch { }
    return $null
}

function Install-Git {
    Write-Host "Git not found" -Level info
    
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  Installing Git via winget..." -Level info
        try {
            winget install Git.Git --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
            Refresh-ProcessPath
            Write-Host "  Git installed" -Level success
            return $true
        } catch {
            Write-Host "  Winget install failed" -Level warn
        }
    }
    
    Write-Host "Please install Git for Windows from: https://git-scm.com" -Level error
    return $false
}

function Ensure-Git {
    $gitVersion = Get-GitVersion
    if ($gitVersion) {
        Write-Host "$gitVersion found" -Level success
        return $true
    }
    return Install-Git
}

function Install-OpenClawNpm {
    param([string]$Target = "latest")

    $installSpec = Resolve-PackageInstallSpec -Target $Target
    
    Write-Host "Installing OpenClaw ($installSpec)..." -Level info

    if (!(Ensure-NpmAccess)) {
        return $false
    }

    $result = Invoke-ExternalCommand -File "npm" -Arguments @("install", "-g", $installSpec, "--no-fund", "--no-audit")
    if ($result.Ok) {
        Write-Host "OpenClaw installed" -Level success
        return $true
    }

    Write-InstallFailureGuidance -Tool "npm install -g" -Output $result.Text
    return $false
}

function Install-OpenClawGit {
    param([string]$RepoDir, [switch]$Update)
    
    Write-Host "Installing OpenClaw from git..." -Level info
    
    if (!(Test-Path $RepoDir)) {
        Write-Host "  Cloning repository..." -Level info
        git clone https://github.com/openclaw/openclaw.git $RepoDir 2>&1
    } elseif ($Update) {
        Write-Host "  Updating repository..." -Level info
        git -C $RepoDir pull --rebase 2>&1
    }
    
    # Install pnpm if not present
    if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Host "  Installing pnpm..." -Level info
        npm install -g pnpm 2>&1
    }
    
    # Install dependencies
    Write-Host "  Installing dependencies..." -Level info
    pnpm install --dir $RepoDir 2>&1
    
    # Build
    Write-Host "  Building..." -Level info
    pnpm --dir $RepoDir build 2>&1
    
    # Create wrapper
    $wrapperDir = "$env:USERPROFILE\.local\bin"
    if (!(Test-Path $wrapperDir)) {
        New-Item -ItemType Directory -Path $wrapperDir -Force | Out-Null
    }
    
    @"
@echo off
node "%~dp0..\openclaw\dist\entry.js" %*
"@ | Out-File -FilePath "$wrapperDir\openclaw.cmd" -Encoding ASCII -Force
    
    Write-Host "OpenClaw installed" -Level success
    return $true
}

function Test-ExplicitPackageInstallSpec {
    param([string]$Target)

    if ([string]::IsNullOrWhiteSpace($Target)) {
        return $false
    }

    return $Target.Contains("://") -or
        $Target.Contains("#") -or
        $Target -match '^(file|github|git\+ssh|git\+https|git\+http|git\+file|npm):'
}

function Resolve-PackageInstallSpec {
    param([string]$Target = "latest")

    $trimmed = $Target.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return "openclaw@latest"
    }
    if ($trimmed.ToLowerInvariant() -eq "main") {
        return "github:openclaw/openclaw#main"
    }
    if (Test-ExplicitPackageInstallSpec -Target $trimmed) {
        return $trimmed
    }
    return "openclaw@$trimmed"
}

function Add-ToPath {
    param([string]$Path)
    
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -notlike "*$Path*") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$Path", "User")
        Write-Host "Added $Path to user PATH" -Level info
    }
}

# Main
function Main {
    Write-Banner
    
    Write-Host "Windows detected" -Level success
    Write-WindowsPathChoiceNote
    Write-Host ""
    
    # Check and handle execution policy FIRST, before any npm calls
    if (!(Ensure-ExecutionPolicy)) {
        Write-Host ""
        Write-Host "Installation cannot continue due to execution policy restrictions" -Level error
        exit 1
    }
    
    if (!(Ensure-Node)) {
        exit 1
    }
    if (!(Ensure-NpmAccess)) {
        exit 1
    }
    
    if ($InstallMethod -eq "git") {
        if (!(Ensure-Git)) {
            exit 1
        }
        
        if ($DryRun) {
            Write-Host "[DRY RUN] Would install OpenClaw from git to $GitDir" -Level info
        } else {
            Install-OpenClawGit -RepoDir $GitDir -Update:(-not $NoGitUpdate)
        }
    } else {
        # npm method
        if (!(Ensure-Git)) {
            Write-Host "Git is required for npm installs. Please install Git and try again." -Level warn
        }
        
        if ($DryRun) {
            Write-Host "[DRY RUN] Would install OpenClaw via npm ($((Resolve-PackageInstallSpec -Target $Tag)))" -Level info
        } else {
            if (!(Install-OpenClawNpm -Target $Tag)) {
                exit 1
            }
        }
    }
    
    # Try to add npm global bin to PATH
    try {
        $npmPrefix = npm config get prefix 2>$null
        if ($npmPrefix) {
            Add-ToPath -Path "$npmPrefix"
        }
    } catch { }

    Refresh-ProcessPath

    if (!$DryRun) {
        if (!(Verify-OpenClawInstall)) {
            exit 1
        }
    }
    
    if (!$NoOnboard -and !$DryRun) {
        Write-Host ""
        Write-Host "Run 'openclaw onboard' to complete setup." -Level info
        Write-Host "If you want a managed background gateway on native Windows, use: openclaw gateway install" -Level info
        Write-Host "If you prefer the full Windows path, install WSL2 and follow: https://docs.openclaw.ai/platforms/windows" -Level info
    }
    
    Write-Host ""
    Write-Host "OpenClaw installed successfully!" -Level success
}

Main
