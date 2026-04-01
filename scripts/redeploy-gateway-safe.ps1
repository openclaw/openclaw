[CmdletBinding()]
param(
  [int]$HealthTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodeExe = Join-Path $env:ProgramFiles "nodejs\node.exe"
$GatewayCmd = Join-Path $env:USERPROFILE ".openclaw\gateway.cmd"
$HealthUrl = "http://127.0.0.1:18789/healthz"
$GatewayEntry = (Join-Path $RepoRoot "dist\index.js").ToLowerInvariant()
$MaintenancePath = Join-Path $env:USERPROFILE ".openclaw\workspace\memory\openclaw-maintenance.json"
$MaintenanceWindowSeconds = [Math]::Max(300, $HealthTimeoutSeconds + 180)

function Stop-LiveGateway {
  $targets = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.ToLower().Contains($GatewayEntry) -and
    $_.CommandLine -match '(^|\s)gateway(\s|$)'
  }

  foreach ($target in $targets) {
    try {
      Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
    } catch {
      throw "Failed to stop gateway PID $($target.ProcessId): $($_.Exception.Message)"
    }
  }
}

function Set-MaintenanceMarker {
  $dir = Split-Path -Parent $MaintenancePath
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $now = [DateTimeOffset]::UtcNow
  $payload = @{
    serviceId = "openclaw"
    display = "OpenClaw gateway"
    reason = "planned_redeploy"
    status = "active"
    startedAt = $now.ToUnixTimeSeconds()
    expiresAt = $now.AddSeconds($MaintenanceWindowSeconds).ToUnixTimeSeconds()
    requestedBy = "redeploy-gateway-safe.ps1"
    suppressAlerts = $true
    pid = $PID
  }
  $tempPath = "$MaintenancePath.tmp"
  $json = $payload | ConvertTo-Json -Depth 5
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, $utf8NoBom)
  Move-Item -LiteralPath $tempPath -Destination $MaintenancePath -Force
}

function Clear-MaintenanceMarker {
  if (Test-Path -LiteralPath $MaintenancePath) {
    Remove-Item -LiteralPath $MaintenancePath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-NodeScript {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath
  )

  Push-Location $RepoRoot
  try {
    & $NodeExe $ScriptPath
  } finally {
    Pop-Location
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Script failed: $ScriptPath"
  }
}

function Wait-GatewayHealth {
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 10
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {
      Start-Sleep -Seconds 2
      continue
    }
    Start-Sleep -Seconds 2
  }

  throw "Gateway health did not become ready within ${HealthTimeoutSeconds}s"
}

$redeploySucceeded = $false
Set-MaintenanceMarker
try {
  Push-Location $RepoRoot
  try {
    Stop-LiveGateway
    Invoke-NodeScript (Join-Path $RepoRoot "scripts\tsdown-build.mjs")
    Invoke-NodeScript (Join-Path $RepoRoot "scripts\runtime-postbuild.mjs")
    & $NodeExe (Join-Path $RepoRoot "scripts\ui.js") build
    if ($LASTEXITCODE -ne 0) {
      throw "Script failed: scripts\\ui.js build"
    }
    Invoke-NodeScript (Join-Path $RepoRoot "scripts\build-stamp.mjs")
  } finally {
    Pop-Location
  }

  Start-Process -FilePath $GatewayCmd | Out-Null
  Wait-GatewayHealth
  $redeploySucceeded = $true
  Write-Host "OpenClaw gateway redeployed and healthy."
} finally {
  Clear-MaintenanceMarker
}
