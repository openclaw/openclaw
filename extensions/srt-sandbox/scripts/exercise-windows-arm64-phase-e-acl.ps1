[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $AddonPath
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $AddonPath)) { throw "Native addon is absent: $AddonPath" }

# The root-store fault occurs immediately after the retained root handle has
# received and re-verified its owner, protected DACL, and mandatory label.
$addon = [System.IO.Path]::GetFullPath($AddonPath).Replace("\", "\\")
$program = @"
const addon = require('$addon');
try { addon.run('setup', 'fault:root-store'); process.exitCode = 2; }
catch (error) {
  if (!String(error.message || error).includes('PHASE_E_FAULT_INJECTED')) throw error;
}
"@
& node.exe -e $program
if ($LASTEXITCODE -ne 0) { throw "ACL path did not reach the post-root fault boundary." }

$canonical = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^srt-w0-0[1-8]$' })
if ($canonical.Count -ne 0) { throw "ACL fault rollback left canonical accounts behind." }
if (Test-Path "$env:ProgramData\srt-sandbox") { throw "ACL fault rollback left the Phase E root behind." }
Write-Host "Windows ARM64 ACL exercise passed: post-ACL fault reached; canonical=0; root=absent."
