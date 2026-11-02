[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') { throw 'Owned disposable GitHub-hosted Windows only.' }
Assert-Base $Source
if (Test-Path -LiteralPath $Artifacts) { throw 'Refuse stale real-source admission.' }
New-Item -ItemType Directory -Path $Artifacts | Out-Null
$patch = Join-Path $PSScriptRoot 'ollama-windows-composed.patch'
if ((Hash $patch) -cne 'fd1d39dfb6184ac07fa359990c4c42a2348b26954543f63d7e4e3794d5ec6a95') { throw 'Reviewed product patch differs.' }
Invoke-Checked 'git' @('-C',$Source,'apply','--check',$patch)
Invoke-Checked 'git' @('-C',$Source,'apply',$patch)
Assert-Product $Source
Save-Json @{base='d38ebb418c3aba6b24a4d6470def72b2bba4c4a8';productPatchSha256=(Hash $patch);productFiles=21;comparisonOverlay=$false;realAppOverlay='added and separately frozen by the opt-in driver';qualification='Product source only, not a native execution receipt.'} (Join-Path $Artifacts 'source-admission.json')
