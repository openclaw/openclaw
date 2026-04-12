<#
.SYNOPSIS
  One-time setup: downloads, registers, and installs the GitHub Actions
  self-hosted runner as a Windows service on this machine.

  Also configures OpenClaw service failure-recovery so it restarts
  automatically on crash.

.PARAMETER RepoUrl
  Full GitHub repo URL.  Example: https://github.com/rhinoroo/openclaw

.PARAMETER Token
  One-time registration token.
  Generate at: GitHub repo -> Settings -> Actions -> Runners -> New self-hosted runner
  Tokens expire after 1 hour -- generate one right before running this script.

.PARAMETER OpenclawDir
  Absolute path to the openclaw installation directory (where this repo is cloned).
  Default: parent of the scripts\ folder (the repo root).

.PARAMETER RunnerDir
  Where to extract the GitHub Actions runner.  Default: C:\actions-runner

.EXAMPLE
  # Run as Administrator in PowerShell:
  .\scripts\setup-local-runner.ps1 `
    -RepoUrl    'https://github.com/rhinoroo/openclaw' `
    -Token      'AXXXXXXXXXXXXXXXXXX' `
    -OpenclawDir 'C:\openclaw'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $RepoUrl,
  [Parameter(Mandatory)] [string] $Token,
  [string] $OpenclawDir = (Split-Path $PSScriptRoot),
  [string] $RunnerDir   = 'C:\actions-runner'
)

$ErrorActionPreference = 'Stop'

# ---- Require Administrator --------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal]
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Error 'This script must be run as Administrator. Right-click PowerShell -> Run as Administrator.'
  exit 1
}

Write-Host ""
Write-Host "=== OpenClaw local runner setup ==="
Write-Host "  Repo       : $RepoUrl"
Write-Host "  RunnerDir  : $RunnerDir"
Write-Host "  OpenclawDir: $OpenclawDir"
Write-Host ""

# ---- Create runner directory ------------------------------------------------
if (-not (Test-Path $RunnerDir)) {
  New-Item -ItemType Directory -Path $RunnerDir | Out-Null
  Write-Host "Created $RunnerDir"
}

# ---- Download runner if not already present ---------------------------------
$configCmd = Join-Path $RunnerDir 'config.cmd'
if (-not (Test-Path $configCmd)) {
  Write-Host 'Fetching latest runner release info ...'
  $release = Invoke-RestMethod 'https://api.github.com/repos/actions/runner/releases/latest'
  $asset   = $release.assets |
              Where-Object { $_.name -like 'actions-runner-win-x64-*.zip' } |
              Select-Object -First 1

  if (-not $asset) {
    Write-Error 'Could not find a win-x64 runner asset in the latest release.'
    exit 1
  }

  $zipPath = Join-Path $env:TEMP 'actions-runner.zip'
  Write-Host "Downloading $($asset.name) ..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
  Write-Host "Extracting to $RunnerDir ..."
  Expand-Archive -Path $zipPath -DestinationPath $RunnerDir -Force
  Remove-Item $zipPath
  Write-Host 'Runner extracted.'
} else {
  Write-Host 'Runner already extracted -- skipping download.'
}

# ---- Register with GitHub ---------------------------------------------------
Write-Host ''
Write-Host 'Configuring runner ...'
Push-Location $RunnerDir
try {
  .\config.cmd `
    --url         $RepoUrl `
    --token       $Token `
    --name        'openclaw-windows' `
    --labels      'self-hosted,Windows,openclaw-local' `
    --work        '_work' `
    --unattended
} finally {
  Pop-Location
}

# ---- Write OPENCLAW_DIR to runner .env so deploy-local.ps1 can find it -----
$envFile = Join-Path $RunnerDir '.env'
$newLine = "OPENCLAW_DIR=$OpenclawDir"
if (Test-Path $envFile) {
  $lines = Get-Content $envFile | Where-Object { $_ -notmatch '^OPENCLAW_DIR=' }
  $lines += $newLine
  Set-Content $envFile $lines
} else {
  Set-Content $envFile $newLine
}
Write-Host "Wrote OPENCLAW_DIR to $envFile"

# ---- Install runner as Windows service --------------------------------------
Write-Host ''
Write-Host 'Installing runner as Windows service ...'
Push-Location $RunnerDir
try {
  .\svc.cmd install
  .\svc.cmd start
} finally {
  Pop-Location
}
Write-Host 'Runner service installed and started.'

# ---- Configure OpenClaw service failure recovery ----------------------------
Write-Host ''
$ocSvc = Get-Service -Name 'OpenClaw' -ErrorAction SilentlyContinue
if ($ocSvc) {
  Write-Host 'Configuring OpenClaw service failure recovery (auto-restart on crash) ...'
  # reset failure count after 24 h; restart after 5 s, 15 s, 60 s
  sc.exe failure OpenClaw reset=86400 actions=restart/5000/restart/15000/restart/60000 | Out-Null
  # Also ensure the service restarts even on non-zero exit codes
  sc.exe failureflag OpenClaw 1 | Out-Null
  Write-Host 'OpenClaw failure recovery configured.'
} else {
  Write-Host 'Note: OpenClaw service not found yet.'
  Write-Host 'Once you create it, run this to add failure recovery:'
  Write-Host '  sc.exe failure OpenClaw reset=86400 actions=restart/5000/restart/15000/restart/60000'
  Write-Host '  sc.exe failureflag OpenClaw 1'
}

# ---- Print summary ----------------------------------------------------------
Write-Host ''
Write-Host '=== Setup complete ==='
Write-Host ''
Write-Host 'Runner service : actions.runner.rhinoroo-openclaw.openclaw-windows'
Write-Host "OPENCLAW_DIR   : $OpenclawDir"
Write-Host ''
Write-Host 'Useful runner commands:'
Write-Host "  Get-Service 'actions.runner.*'"
Write-Host "  Restart-Service 'actions.runner.rhinoroo-openclaw.openclaw-windows'"
Write-Host ''
Write-Host 'To verify: push any commit to main (or trigger the workflow manually)'
Write-Host "then check: $OpenclawDir\logs\deploy.log"
Write-Host ''
Write-Host 'IMPORTANT: The runner service must run under an account with permission'
Write-Host 'to stop and start the OpenClaw service (typically a local admin account).'
Write-Host 'If the default NETWORK SERVICE account is used, open Services.msc and'
Write-Host 'change the runner service logon to your admin account.'
