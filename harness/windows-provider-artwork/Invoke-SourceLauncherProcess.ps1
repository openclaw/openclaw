[CmdletBinding()]
param([Parameter(Mandatory)][string]$ArgumentsPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$spec=Get-Content -LiteralPath $ArgumentsPath -Raw | ConvertFrom-Json -AsHashtable
if ((Get-FileHash -LiteralPath $spec.launcher -Algorithm SHA256).Hash.ToLowerInvariant() -cne $spec.sha256) { throw 'Source launcher identity changed before invocation.' }
# Typed argument data crosses the process boundary as JSON, never executable text.
$parameters=$spec.parameters
$global:LASTEXITCODE=0
& $spec.launcher @parameters
exit $global:LASTEXITCODE
