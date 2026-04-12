<#
.SYNOPSIS
  Pulls the latest openclaw main, rebuilds, and restarts the Windows service.
  Called by the self-hosted GitHub Actions runner via deploy-local.yml.

.PARAMETER ServiceName
  Windows service name for openclaw.  Default: OpenClaw

.PARAMETER SkipBuild
  Skip git pull, pnpm install, and pnpm build.  Restarts the service only.
  Set automatically by the workflow's manual skip_build input.
#>
[CmdletBinding()]
param(
  [string] $ServiceName = 'OpenClaw',
  [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'

# ---- Paths ------------------------------------------------------------------
$RepoRoot = Split-Path $PSScriptRoot     # scripts\ -> repo root
$LogDir   = Join-Path $RepoRoot 'logs'
$LogFile  = Join-Path $LogDir 'deploy.log'

if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

function Write-Log {
  param([string]$Msg)
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Msg"
  $line | Tee-Object -FilePath $LogFile -Append
}

# ---- Ensure node / pnpm are reachable from the service account PATH ---------
$extraPaths = @(
  "$env:LOCALAPPDATA\pnpm",
  "$env:APPDATA\npm",
  'C:\Program Files\nodejs',
  'C:\Program Files\Git\cmd'
)
foreach ($p in $extraPaths) {
  if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
    $env:PATH = "$p;$env:PATH"
  }
}

# ---- Start ------------------------------------------------------------------
Write-Log ''
Write-Log "=== Deploy started  (SkipBuild=$SkipBuild) ==="
$prevSha = git -C $RepoRoot rev-parse --short HEAD 2>$null
Write-Log "Commit before : $prevSha"

# ---- Stop service -----------------------------------------------------------
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $svc) {
  Write-Log "WARNING: Service '$ServiceName' not found. Continuing with build only."
} elseif ($svc.Status -ne 'Stopped') {
  Write-Log "Stopping $ServiceName ..."
  Stop-Service -Name $ServiceName -Force
  $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
  Write-Log "$ServiceName stopped."
}

# ---- Update and build -------------------------------------------------------
$buildOk = $true

if (-not $SkipBuild) {
  try {
    Write-Log 'Fetching origin main ...'
    $out = git -C $RepoRoot fetch origin main --tags 2>&1
    $out | ForEach-Object { Write-Log "  git: $_" }

    Write-Log 'Resetting to origin/main ...'
    $out = git -C $RepoRoot reset --hard origin/main 2>&1
    $out | ForEach-Object { Write-Log "  git: $_" }
    $newSha = git -C $RepoRoot rev-parse --short HEAD 2>$null
    Write-Log "Commit after  : $newSha"

    Push-Location $RepoRoot
    try {
      Write-Log 'Running pnpm install --frozen-lockfile ...'
      $out = pnpm install --frozen-lockfile 2>&1
      $installExit = $LASTEXITCODE
      $out | ForEach-Object { Write-Log "  pnpm: $_" }
      if ($installExit -ne 0) { throw "pnpm install exited $installExit" }

      Write-Log 'Running pnpm build ...'
      $out = pnpm build 2>&1
      $buildExit = $LASTEXITCODE
      $out | ForEach-Object { Write-Log "  pnpm: $_" }
      if ($buildExit -ne 0) { throw "pnpm build exited $buildExit" }

      Write-Log 'Build complete.'
    } finally {
      Pop-Location
    }
  } catch {
    Write-Log "ERROR: $_"
    Write-Log 'Build failed. Service will restart using previous dist/ artifacts.'
    $buildOk = $false
  }
} else {
  Write-Log 'SkipBuild is set -- skipping pull, install, and build.'
}

# ---- Restart service --------------------------------------------------------
if ($null -ne $svc) {
  Write-Log "Starting $ServiceName ..."
  Start-Service -Name $ServiceName
  $svc.Refresh()
  $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
  Write-Log "$ServiceName is running."
}

# ---- Done -------------------------------------------------------------------
if ($buildOk) {
  Write-Log '=== Deploy complete ==='
} else {
  Write-Log '=== Deploy finished with build errors -- running previous build ==='
  exit 1
}
