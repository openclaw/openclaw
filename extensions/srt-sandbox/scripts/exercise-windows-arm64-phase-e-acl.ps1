[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $AddonPath
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $AddonPath)) { throw "Native addon is absent: $AddonPath" }

$addon = [System.IO.Path]::GetFullPath($AddonPath).Replace("\", "\\")
$foreignBefore = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -like 'srt-*' -and $_.Name -notmatch '^srt-w0-0[1-8]$' } | ForEach-Object { "{0}:{1}:{2}" -f $_.Name, $_.SID.Value, $_.Enabled })

$setupProgram = @"
const addon = require('$addon');
console.log(addon.run('setup'));
"@
$setupJson = & node.exe -e $setupProgram
if ($LASTEXITCODE -ne 0) { throw "Full Phase E setup failed before SETUP_COMPLETE." }
$setup = $setupJson | ConvertFrom-Json
if ($setup.outcome -ne "SETUP_COMPLETE" -or @($setup.canonicalAccounts).Count -ne 8) {
  throw "Full Phase E setup did not return the expected sanitized evidence."
}
if (-not (Test-Path "$env:ProgramData\srt-sandbox\lease-store.lock") -or
    -not (Test-Path "$env:ProgramData\srt-sandbox\lease-store.json") -or
    -not (Test-Path "$env:ProgramData\srt-sandbox\phase-e-manifest.dpapi")) {
  throw "Full Phase E setup did not persist the manifest, stable lock, and lease store."
}

$authorization = @{ owner = "srt-phase-e-maintainer"; createdAccounts = $setup.canonicalAccounts } | ConvertTo-Json -Compress
$encodedAuthorization = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($authorization))
$teardownProgram = @"
const addon = require('$addon');
const authorization = Buffer.from('$encodedAuthorization', 'base64').toString('utf8');
console.log(addon.run('teardown', authorization));
"@
$teardownJson = & node.exe -e $teardownProgram
if ($LASTEXITCODE -ne 0) { throw "Manifest-owned teardown failed." }
$teardown = $teardownJson | ConvertFrom-Json
if ($teardown.outcome -ne "TEARDOWN_COMPLETE" -or @($teardown.canonicalAccounts).Count -ne 0) {
  throw "Manifest-owned teardown did not return the expected sanitized evidence."
}

$canonical = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^srt-w0-0[1-8]$' })
if ($canonical.Count -ne 0) { throw "ACL teardown left canonical accounts behind." }
if (Test-Path "$env:ProgramData\srt-sandbox") { throw "ACL teardown left the Phase E root behind." }
$foreignAfter = @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -like 'srt-*' -and $_.Name -notmatch '^srt-w0-0[1-8]$' } | ForEach-Object { "{0}:{1}:{2}" -f $_.Name, $_.SID.Value, $_.Enabled })
if (Compare-Object $foreignBefore $foreignAfter) { throw "Foreign srt-* account state changed." }
Write-Host "Windows ARM64 ACL exercise passed: SETUP_COMPLETE; authenticated TEARDOWN_COMPLETE; canonical=0; root=absent; foreign=$($foreignAfter.Count) unchanged."
