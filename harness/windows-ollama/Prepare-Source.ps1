[CmdletBinding()]
param([Parameter(Mandatory)][string]$BeforeSource,[Parameter(Mandatory)][string]$AfterSource,[Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
$BeforeSource = Resolve-ExistingDirectory $BeforeSource
$AfterSource = Resolve-ExistingDirectory $AfterSource
if ($BeforeSource -ceq $AfterSource) { throw 'Independent fresh source copies are required.' }
Assert-Base $BeforeSource
Assert-Base $AfterSource
if (Test-Path -LiteralPath $Artifacts) { throw 'Refuse stale artifact destination.' }
New-Item -ItemType Directory -Path ([IO.Path]::GetFullPath($Artifacts)) | Out-Null
$Artifacts = Resolve-ExistingDirectory $Artifacts
$patch = Join-Path $PSScriptRoot 'ollama-windows-composed.patch'
$evidence = Get-Content (Join-Path $PSScriptRoot 'composed-evidence.json') -Raw | ConvertFrom-Json
if ((Hash $patch) -cne $evidence.patch.sha256) { throw 'Reviewed source patch differs.' }
Invoke-Checked 'git' @('-C',$AfterSource,'apply','--check',$patch)
Invoke-Checked 'git' @('-C',$AfterSource,'apply',$patch)
Assert-Product $AfterSource
$overlays = Get-Content (Join-Path $PSScriptRoot 'TEST-OVERLAYS.json') -Raw | ConvertFrom-Json
foreach ($source in @($BeforeSource,$AfterSource)) {
    foreach ($overlay in $overlays.common) {
        $path = Join-Path $source $overlay.path
        if ($overlay.PSObject.Properties['inputSha256']) {
            if ((Hash $path) -cne $overlay.inputSha256) { throw 'Common test-owner input differs.' }
            $original = [IO.File]::ReadAllText($path)
            $marker = '    private bool _nativeProof;'
            if ([regex]::Matches($original,[regex]::Escape($marker)).Count -ne 1) { throw 'Comparison anchor is not unique.' }
            $post = $original.Replace($marker,$marker + [char]10 + [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'comparison-method.txt')))
            if ($post -cne [IO.File]::ReadAllText((Join-Path $PSScriptRoot $overlay.packetPostimage))) { throw 'Comparison must be the exact declared test-only insertion.' }
        } elseif (Test-Path -LiteralPath $path) { throw 'Refuse an existing common helper.' }
        [IO.File]::WriteAllBytes($path,[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $overlay.packetPostimage)))
        if ((Hash $path) -cne $overlay.sha256) { throw 'Common overlay postimage differs.' }
    }
}
foreach ($overlay in $overlays.afterOnly) {
    $path = Join-Path $AfterSource $overlay.path
    if ($overlay.PSObject.Properties['inputSha256']) {
        if ((Hash $path) -cne $overlay.inputSha256) { throw 'Product-test input differs from the reviewed repaired candidate.' }
        $original = [IO.File]::ReadAllText($path)
        $old = '                OnboardingNativeProof.ActivateOwned(window);'
        $new = '                if (OllamaPrivateMountedPresentation.IsRequested)' + [char]10 +
            '                    await OllamaPrivateMountedPresentation.PresentAsync(window);' + [char]10 +
            '                else' + [char]10 + '    ' + $old
        if ([regex]::Matches($original,[regex]::Escape($old)).Count -ne 1 -or
            $original.Replace($old,$new) -cne [IO.File]::ReadAllText((Join-Path $PSScriptRoot $overlay.packetPostimage))) { throw 'Product-test overlay may change only its presentation boundary.' }
    } elseif (Test-Path -LiteralPath $path) { throw 'Refuse an existing OS inspection overlay.' }
    [IO.File]::WriteAllBytes($path,[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $overlay.packetPostimage)))
    if ((Hash $path) -cne $overlay.sha256) { throw 'After-only postimage differs.' }
}
$beforeDelta = @(@(Invoke-Git $BeforeSource @('diff','--name-only','HEAD')) + @(Invoke-Git $BeforeSource @('ls-files','--others','--exclude-standard')) | Sort-Object -Unique)
if (@(Compare-Object (@($overlays.common.path) | Sort-Object) $beforeDelta).Count -ne 0) { throw 'Before may contain only the common test plumbing.' }
foreach ($source in @($BeforeSource,$AfterSource)) { Invoke-Checked 'git' @('-C',$source,'diff','--check') }
Assert-Product $AfterSource -WithComparison
Save-Json @{base=$evidence.base;productPatchSha256=$evidence.patch.sha256;productFiles=$evidence.files.Count;
    productAdmission='All product postimages verified before the test-only overlays.';overlays=$overlays;
    commonHelperAndComparisonByteEqual=$true;baselineProductionChanged=$false;stagedChanges=$false} (Join-Path $Artifacts 'source-admission.json')
