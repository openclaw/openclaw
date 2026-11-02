[CmdletBinding()]
param([Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
$Artifacts=Resolve-ExistingDirectory $Artifacts
$expected=@('retained-proof-admission','full-build','Shared-build','Shared-full-tests','SetupEngine-build','SetupEngine-artwork-owner-repair-3-cases',
    'After-UI-build','After-private-native-UI','Before-UI-build','Before-private-native-UI','source-postflight')
$qualified=$false;$diagnostic='Required current repair receipts are incomplete.'
try {
    $summary=Get-Content (Join-Path $Artifacts 'required-summary.json') -Raw|ConvertFrom-Json
    $retained=Get-Content (Join-Path $Artifacts 'retained-evidence.json') -Raw|ConvertFrom-Json
    $before=Get-Content (Join-Path $Artifacts 'Before/result.json') -Raw|ConvertFrom-Json
    $after=Get-Content (Join-Path $Artifacts 'After/result.json') -Raw|ConvertFrom-Json
    if ($summary.failed -ne 0 -or $summary.gates.Count -ne $expected.Count) { throw 'Current repair gate inventory did not pass.' }
    foreach($name in $expected){if(@($summary.gates|Where-Object {$_.name -ceq $name -and $_.status -ceq 'passed'}).Count -ne 1){throw "Missing current repair gate: $name"}}
    $strict=$retained.passedSuites.PSObject.Properties['strict-owners'].Value
    if($retained.runId -ne 41495507649 -or $strict.passed -ne 17 -or $strict.failed -ne 0 -or $strict.skipped -ne 0 -or
        $before.executed -ne 2 -or $before.skipped -ne 0 -or $after.executed -ne 12 -or $after.skipped -ne 0){throw 'The31-case current/reused matrix does not qualify.'}
    foreach($stage in @('Before','After')){
        $v=Get-Content (Join-Path $Artifacts "$stage-calculated-version.json") -Raw|ConvertFrom-Json
        if($v.sha -cne 'd38ebb418c3aba6b24a4d6470def72b2bba4c4a8' -or $v.evaluated.WriteVersionInfoToBuildLog -cne 'false' -or $v.evaluated.DisableGitVersionTask -cne 'false'){throw 'Calculated source-version binding was not retained.'}
    }
    $qualified=$true;$diagnostic='Current scoped repair gates passed with explicitly retained independent prior scopes. Original failures are preserved, not erased.'
}catch{$diagnostic=$_.Exception.Message}
$source=Get-Content (Join-Path $PSScriptRoot 'composed-evidence.json') -Raw|ConvertFrom-Json
Save-Json @{status=$(if($qualified){'repair-fixture-gates-qualified-human-image-review-required'}else{'repair-fixture-gates-blocked'});
    productBase=$source.base;productPatchSha256=$source.patch.sha256;diagnostic=$diagnostic;
    priorRun=41495507649;priorRunStatus='FAILED; zeroPNG; no native acceptance';currentRepairNotExecutedByPacketPreparation=$true;
    strictMatrix=@{reusedPrior17=17;currentBefore2=2;currentAfter12=12;total=31};additionalCurrentArtworkCases=3;requiredFrames=9;
    retainedScopes='Connection1700pass/1ordinaryskip, Tray4799pass, strict17pass/0skip, original canonical docs pass; source closure verified.';
    setupDisposition='Original full suite2560passed/1failed/1skip. Current3-case owning-source repair plus mounted metadata observations resolve that owner only; not a fabricated fresh whole-suite pass.';
    realAppJobs='Dormant and UNREGISTERED. No app acquisition/installation/model action exists in this workflow.';
    foregroundProven=$false;keyboardProven=$false;compositorProven=$false;liveGatewayProven=$false;featureComplete=$false} (Join-Path $Artifacts 'qualification-result.json')
Save-Json @(Get-ChildItem -LiteralPath $Artifacts -File -Recurse|Where-Object {$_.Name -cne 'artifact-hashes.json'}|ForEach-Object {
    @{path=[IO.Path]::GetRelativePath($Artifacts,$_.FullName);sha256=(Hash $_.FullName);bytes=$_.Length}
}) (Join-Path $Artifacts 'artifact-hashes.json')
if(!$qualified){throw 'Current repair fixture gates did not qualify; retain the first failed run and independent passing evidence.'}
