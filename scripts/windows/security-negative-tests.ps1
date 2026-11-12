#!/usr/bin/env pwsh
<#
.SYNOPSIS
Runs read-only Windows security negative tests and records the current gaps.

.DESCRIPTION
Finds plaintext secret-bearing config, shared-path ACL exposure, DPAPI
availability/integration, and whether taskkill can reap a tree after its parent
exited. Default mode records findings and exits 0; -ExpectSecure exits 1 while
any gap remains (the post-fix acceptance mode).
#>
[CmdletBinding()]
param(
  [string]$Out = ".artifacts/security/negative-tests.json",
  [switch]$ExpectSecure
)

$ErrorActionPreference = "Continue"
$root = (Get-Location).Path
$stateDir = if ($env:OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE ".openclaw" } else { "" }
$configPath = if ($stateDir) { Join-Path $stateDir "openclaw.json" } else { "" }
$secretPaths = New-Object System.Collections.Generic.List[string]

function Find-PlaintextSecrets($Value, [string]$Path) {
  if ($null -eq $Value) { return }
  if ($Value -is [string]) {
    if ($Path -match '(?i)(token|api[_-]?key|secret|password|authorization)$' -and $Value.Trim()) {
      $secretPaths.Add($Path) | Out-Null
    }
    return
  }
  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $index = 0
    foreach ($item in $Value) {
      Find-PlaintextSecrets $item "$Path[$index]"
      $index += 1
    }
    return
  }
  if ($Value -is [pscustomobject]) {
    foreach ($property in $Value.PSObject.Properties) {
      Find-PlaintextSecrets $property.Value "$Path.$($property.Name)"
    }
  }
}

$plaintext = [ordered]@{ scanned = $false; found = $false; paths = @(); error = $null }
if ($configPath -and (Test-Path -LiteralPath $configPath)) {
  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $plaintext.scanned = $true
    Find-PlaintextSecrets $config "config"
    $plaintext.found = $secretPaths.Count -gt 0
    $plaintext.paths = @($secretPaths)
  } catch {
    $plaintext.error = $_.Exception.Message
  }
}

$acl = [ordered]@{ exposed = $false; identities = @(); probePath = $null; error = $null }
$probeRoot = Join-Path $env:PUBLIC ("openclaw-acl-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
  $probeFile = Join-Path $probeRoot "secret.txt"
  Set-Content -LiteralPath $probeFile -Value "synthetic-secret" -Encoding ASCII
  $acl.probePath = $probeFile
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($entry in (Get-Acl -LiteralPath $probeFile).Access) {
    $identity = $entry.IdentityReference.Value
    $rights = [string]$entry.FileSystemRights
    $trusted = $identity -eq $currentUser -or $identity -match '(?i)SYSTEM|Administrators'
    if (-not $trusted -and $rights -match '(?i)Read|Modify|FullControl|Write') {
      $acl.exposed = $true
      $acl.identities += "${identity}:${rights}"
    }
  }
} catch {
  $acl.error = $_.Exception.Message
} finally {
  Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$dpapi = [ordered]@{ available = $false; openclawUsesDpapi = $false; error = $null }
try {
  Add-Type -AssemblyName System.Security
  $bytes = [System.Text.Encoding]::UTF8.GetBytes("dpapi-probe")
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $dpapi.available = $protected.Length -gt 0
} catch {
  $dpapi.error = $_.Exception.Message
}
if ($configPath -and (Test-Path -LiteralPath $configPath)) {
  try {
    $raw = Get-Content -LiteralPath $configPath -Raw
    $dpapi.openclawUsesDpapi = $raw -match '(?i)"source"\s*:\s*"dpapi"'
  } catch {}
}

$orphan = [ordered]@{ parentExited = $false; taskkillExit = $null; childSurvived = $false; error = $null }
$tempRoot = Join-Path $env:TEMP ("openclaw-orphan-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $pidFile = Join-Path $tempRoot "child.pid"
  $parentScript = Join-Path $tempRoot "parent.ps1"
  $parentBody = @"
`$child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
Set-Content -LiteralPath "$pidFile" -Value `$child.Id
"@
  Set-Content -LiteralPath $parentScript -Value $parentBody -Encoding UTF8
  $parent = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $parentScript) -PassThru -WindowStyle Hidden
  $parent.WaitForExit(10000) | Out-Null
  $orphan.parentExited = $parent.HasExited
  if (Test-Path -LiteralPath $pidFile) {
    $childPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    & taskkill /PID $parent.Id /T /F 2>$null | Out-Null
    $orphan.taskkillExit = $LASTEXITCODE
    $orphan.childSurvived = [bool](Get-Process -Id $childPid -ErrorAction SilentlyContinue)
    if ($orphan.childSurvived) {
      & taskkill /PID $childPid /T /F 2>$null | Out-Null
    }
  }
} catch {
  $orphan.error = $_.Exception.Message
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$gaps = @()
if ($plaintext.found) { $gaps += "plaintext-config-secrets" }
if ($acl.exposed) { $gaps += "shared-path-acl" }
if (-not $dpapi.openclawUsesDpapi) { $gaps += "no-dpapi-backend" }
if ($orphan.childSurvived) { $gaps += "taskkill-orphan" }

$record = [ordered]@{
  schema = 1
  capturedAt = (Get-Date).ToString("o")
  stateDir = $stateDir
  configPath = $configPath
  plaintextConfig = $plaintext
  sharedPathAcl = $acl
  dpapi = $dpapi
  taskkillOrphan = $orphan
  gaps = $gaps
  secure = $gaps.Count -eq 0
}
New-Item -ItemType Directory -Path (Split-Path -Parent $Out) -Force | Out-Null
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Out -Encoding UTF8
$record | ConvertTo-Json -Depth 8

if ($ExpectSecure -and $gaps.Count -gt 0) {
  Write-Error "Security negative tests still report gaps: $($gaps -join ', ')"
  exit 1
}
exit 0
