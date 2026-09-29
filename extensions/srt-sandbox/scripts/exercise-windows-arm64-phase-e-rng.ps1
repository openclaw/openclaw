[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $AddonPath
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $AddonPath)) { throw "Native addon is absent: $AddonPath" }

# Run only from an elevated interactive console in session 1. The fault is
# deliberately injected after credential generation; CreatePool catches it and
# rolls back only accounts made by this invocation.
$addon = [System.IO.Path]::GetFullPath($AddonPath).Replace("\\", "\\\\")
$program = @"
const addon = require('$addon');
try { addon.run('setup', 'fault:credential'); process.exitCode = 2; }
catch (error) {
  if (!String(error.message || error).includes('PHASE_E_FAULT_INJECTED')) throw error;
}
"@
& node.exe -e $program
if ($LASTEXITCODE -ne 0) { throw "Credential fault did not reach the injected boundary." }

$canonical = @(Get-LocalUser -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^srt-w0-0[1-8]$' })
if ($canonical.Count -ne 0) { throw "Credential fault rollback left canonical accounts behind." }
if (Test-Path "$env:ProgramData\srt-sandbox") { throw "Credential fault rollback left the Phase E root behind." }
Write-Host "Windows ARM64 credential RNG exercise passed: injected fault reached; canonical=0; root=absent."
