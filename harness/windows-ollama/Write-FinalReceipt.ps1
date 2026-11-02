[CmdletBinding()]
param([Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
if (!(Test-Path $Artifacts)) { New-Item -ItemType Directory -Path $Artifacts | Out-Null }
$actualStages = @()
foreach ($relative in @('source-admission.json','required-summary.json','winget-runtime-contract.json','catalog-manifest.json','Before/result.json','After/result.json')) {
    $path = Join-Path $Artifacts $relative
    if (Test-Path $path) { $actualStages += @{path=$relative;sha256=(Hash $path);receipt=(Get-Content $path -Raw | ConvertFrom-Json)} }
}
$expectedGates = @('full-build','canonical-native-docs','Shared-build','Shared-full-tests','Connection-build','Connection-full-tests',
    'Tray-build','Tray-full-tests','SetupEngine-build','SetupEngine-full-tests','strict-ollama-owner-and-admitted-runner-17-cases',
    'After-UI-build','After-private-native-UI','Before-UI-build','Before-private-native-UI','source-postflight')
$qualified=$false
$diagnostic='Required fixture receipts missing or failed.'
try {
    $summary = Get-Content (Join-Path $Artifacts 'required-summary.json') -Raw | ConvertFrom-Json
    $before = Get-Content (Join-Path $Artifacts 'Before/result.json') -Raw | ConvertFrom-Json
    $after = Get-Content (Join-Path $Artifacts 'After/result.json') -Raw | ConvertFrom-Json
    $winget = Get-Content (Join-Path $Artifacts 'winget-runtime-contract.json') -Raw | ConvertFrom-Json
    $catalog = Get-Content (Join-Path $Artifacts 'catalog-manifest.json') -Raw | ConvertFrom-Json
    if ($summary.failed -ne 0 -or $summary.gates.Count -ne $expectedGates.Count) { throw 'Required gate inventory did not pass.' }
    foreach ($name in $expectedGates) {
        if (@($summary.gates | Where-Object {$_.name -ceq $name -and $_.status -ceq 'passed'}).Count -ne 1) { throw "Missing required gate: $name" }
    }
    if ($before.executed -ne 2 -or $before.skipped -ne 0 -or $after.executed -ne 12 -or $after.skipped -ne 0 -or
        $winget.status -cne 'runtime-source-contract-compatible' -or $catalog.status -cne 'pinned-public-catalog-data-verified') { throw 'Native fixture counts or prerequisite receipts did not qualify.' }
    $qualified=$true
    $diagnostic='Only required build/test/read-only native fixture stages qualified; opt-in real-app jobs produce separate receipts.'
} catch { $diagnostic=$_.Exception.Message }
Save-Json @{status=$(if($qualified){'fixture-stages-qualified-real-app-not-run-in-this-job'}else{'fixture-stages-blocked'});
    productBase='d38ebb418c3aba6b24a4d6470def72b2bba4c4a8';productPatchSha256='fd1d39dfb6184ac07fa359990c4c42a2348b26954543f63d7e4e3794d5ec6a95';
    diagnostic=$diagnostic;executedEvidence=$actualStages;expectedStrictCases=31;expectedFrames=9;
    installedAppProof='Separate opt-in Normal and CancelCloseQuit jobs, each on a fresh GitHub-hosted VM; not inferred from these fixtures.';
    stoppedAppOpen='Native boundary blocked: no qualified graceful app shutdown fixture. Existing mounted regression is separate.';
    humanImageReview='required after execution';modelAcquisition='excluded, no consent';liveGatewayInference='not exercised';featureComplete=$false} (Join-Path $Artifacts 'qualification-result.json')
Save-Json @(Get-ChildItem -LiteralPath $Artifacts -File -Recurse | Where-Object {$_.Name -cne 'artifact-hashes.json'} | ForEach-Object {
    @{path=[IO.Path]::GetRelativePath($Artifacts,$_.FullName);sha256=(Hash $_.FullName);bytes=$_.Length}
}) (Join-Path $Artifacts 'artifact-hashes.json')
if (!$qualified) { throw 'Required fixture gates did not qualify. Preserve independent evidence; no native feature acceptance is implied.' }
