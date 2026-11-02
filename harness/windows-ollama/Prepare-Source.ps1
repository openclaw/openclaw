[CmdletBinding()]
param([Parameter(Mandatory)][string]$BeforeSource,[Parameter(Mandatory)][string]$AfterSource,[Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
$BeforeSource = (Resolve-Path -LiteralPath $BeforeSource).Path
$AfterSource = (Resolve-Path -LiteralPath $AfterSource).Path
if ($BeforeSource -ceq $AfterSource) { throw 'Comparison requires independent checkouts.' }
Assert-Base $BeforeSource
Assert-Base $AfterSource
if (Test-Path -LiteralPath $Artifacts) { throw 'Refuse stale artifact directory.' }
New-Item -ItemType Directory -Path $Artifacts | Out-Null
$patch = Join-Path $PSScriptRoot 'ollama-windows-composed.patch'
if ((Hash $patch) -cne 'fd1d39dfb6184ac07fa359990c4c42a2348b26954543f63d7e4e3794d5ec6a95') { throw 'Product patch seal differs.' }
Invoke-Checked 'git' @('-C',$AfterSource,'apply','--check',$patch)
Invoke-Checked 'git' @('-C',$AfterSource,'apply',$patch)
Assert-Product $AfterSource
$relative = 'tests/OpenClaw.Tray.UITests/OnboardingAiPageTests.cs'
$original = [IO.File]::ReadAllText((Join-Path $BeforeSource $relative))
if ([IO.File]::ReadAllText((Join-Path $AfterSource $relative)) -cne $original) { throw 'Comparison owner must have the same unmodified base bytes.' }
$marker = '    private bool _nativeProof;'
if ([regex]::Matches($original,[regex]::Escape($marker)).Count -ne 1) { throw 'Comparison anchor is not unique.' }
$overlay = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'comparison-method.txt'))
$composed = $original.Replace($marker,$marker + "
" + $overlay)
foreach ($source in @($BeforeSource,$AfterSource)) {
    [IO.File]::WriteAllText((Join-Path $source $relative),$composed,[Text.UTF8Encoding]::new($false))
    Invoke-Checked 'git' @('-C',$source,'diff','--check')
}
$beforeDelta = @(Invoke-Git $BeforeSource @('diff','--name-only','HEAD'))
if ($beforeDelta.Count -ne 1 -or $beforeDelta[0] -cne $relative -or @(Invoke-Git $BeforeSource @('ls-files','--others','--exclude-standard')).Count -ne 0) { throw 'Before must contain the identical test overlay only.' }
Assert-Product $AfterSource -WithComparison
Save-Json @{base='d38ebb418c3aba6b24a4d6470def72b2bba4c4a8';productPatchSha256=(Hash $patch);productFiles=21;overlayPath=$relative;overlaySha256=(Hash (Join-Path $PSScriptRoot 'comparison-method.txt'));beforeOverlayPostimage=(Hash (Join-Path $BeforeSource $relative));afterOverlayPostimage=(Hash (Join-Path $AfterSource $relative));baselineFlag=$false;stagedChanges=$false} (Join-Path $Artifacts 'source-admission.json')
