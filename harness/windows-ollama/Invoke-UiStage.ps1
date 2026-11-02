[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][ValidateSet('Before','After')][string]$Stage,[Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
$Source = Resolve-ExistingDirectory $Source
$Artifacts = Resolve-ExistingDirectory $Artifacts
$out = Join-Path $Artifacts $Stage
$freeze = Join-Path $Artifacts "freeze-$Stage"
if ((Test-Path $out) -or (Test-Path $freeze)) { throw 'Refuse stale UI proof.' }
New-Item -ItemType Directory -Path $out,$freeze | Out-Null
$env:OPENCLAW_REPO_ROOT = $Source
$env:GitVersion_NoNormalizeEnabled = 'true'
$env:GitVersion_NoFetchEnabled = 'true'
$env:OPENCLAW_TRAY_APPDATA_DIR = Join-Path $env:RUNNER_TEMP "ollama-$Stage-roaming"
$env:OPENCLAW_UI_PROOF_DIR = $out
$env:OPENCLAW_UI_PROOF_FREEZE_DIR = $freeze
$env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR = $out
$env:OPENCLAW_OLLAMA_PRIVATE_CAPTURE_JOB = 'fixture-v1'
$env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD = 'd38ebb418c3aba6b24a4d6470def72b2bba4c4a8'
$files = @(Source-Manifest $Source)
foreach ($file in $files) { $file.sha256 = $file.sha256.ToUpperInvariant() }
Save-Json $files (Join-Path $freeze 'full-source-manifest.json')
$bin = Join-Path $Source 'tests/OpenClaw.Tray.UITests/bin/Debug/net10.0-windows10.0.22621.0/win-x64'
$binaries = @(Get-ChildItem -LiteralPath $bin -File | Sort-Object Name | ForEach-Object {
    @{path="build\ui-tests\$($_.Name)";sha256=(Hash $_.FullName).ToUpperInvariant()}
})
if ($binaries.Count -eq 0) { throw 'No UI binaries.' }
Save-Json $binaries (Join-Path $freeze 'build-manifest.json')
Save-Json @{head=$env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD;fullSourceManifestSha=(Hash (Join-Path $freeze 'full-source-manifest.json')).ToUpperInvariant();buildManifestSha=(Hash (Join-Path $freeze 'build-manifest.json')).ToUpperInvariant()} (Join-Path $freeze 'manifest.json')
$env:OPENCLAW_UI_PROOF_MANIFEST_SHA256 = (Hash (Join-Path $freeze 'manifest.json')).ToUpperInvariant()
$filter = 'FullyQualifiedName~OnboardingAiPageTests.NativeOllamaComparison_IdenticalAdvertisedNoModel'
$expected = 2
$nativeFrames = @('ollama-identical-advertised-no-model-Light','ollama-identical-advertised-no-model-Dark')
$mountedFrames = @()
if ($Stage -ceq 'After') {
    Assert-Product $Source -WithComparison
    $filter += '|FullyQualifiedName~OnboardingOllamaPageTests|FullyQualifiedName~NativeOllamaOsInspectionTests'
    $expected = 12 # 2 identical comparison + 9 actual mounted product regressions + 1 real OS inspection.
    $nativeFrames += 'ollama-real-windows-inspection'
    $mountedFrames = @('ollama-install-review','ollama-install-needs-model','ollama-open-review','ollama-open-needs-model')
}
Push-Location $Source
try {
    . (Join-Path $Source 'scripts/TestResultContract.ps1')
    $invocation = New-TestInvocation -ResultsDirectory (Join-Path $out 'trx') -TrxFileName "$Stage.trx"
    Invoke-Checked 'dotnet' @('test','tests/OpenClaw.Tray.UITests/OpenClaw.Tray.UITests.csproj','--no-build','--no-restore','-c','Debug','-r','win-x64',
        '--filter',$filter,'--results-directory',$invocation.directory,'--logger',"trx;LogFileName=$Stage.trx",'--blame-hang','--blame-hang-timeout','180s','--blame-hang-dump-type','none')
    Assert-StrictTrx $invocation.report $expected $invocation.startedUtc
    $images = @(Get-ChildItem -LiteralPath $out -Filter '*.png' -File)
    if ($images.Count -ne $nativeFrames.Count + $mountedFrames.Count) { throw 'Unexpected native image inventory.' }
    foreach ($name in @($nativeFrames) + @($mountedFrames)) {
        $receipt = Get-Content -LiteralPath (Join-Path $out "$name.json") -Raw | ConvertFrom-Json
        if ((Hash (Join-Path $out "$name.png")) -cne $receipt.imageSha256.ToLowerInvariant() -or
            $receipt.head -cne $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD -or
            $receipt.assemblySha256.ToLowerInvariant() -cne (Hash (Join-Path $bin 'OpenClaw.Tray.UITests.dll')) -or
            $receipt.method -cne 'PrintWindow(PW_RENDERFULLCONTENT); no fallback' -or
            $receipt.qualification -cne 'Synthetic dependencies; private owned production window. Not native compositor, keyboard, installed-app, or live Gateway proof.') { throw "Mounted image binding failed: $name" }
    }
    foreach ($name in $nativeFrames) {
        $required = Get-Content -LiteralPath (Join-Path $out "$name.required.json") -Raw | ConvertFrom-Json
        $labels = if ($name -ceq 'ollama-real-windows-inspection') { @('Ollama') } else { @('Set up your AI','Ollama') }
        if ($required.schema -cne 'ollama-private-mounted-required-v1' -or $required.state -cne $name -or
            $required.head -cne $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD -or
            $required.freezeManifestSha256 -cne $env:OPENCLAW_UI_PROOF_MANIFEST_SHA256 -or
            $required.assemblySha256.ToLowerInvariant() -cne (Hash (Join-Path $bin 'OpenClaw.Tray.UITests.dll')) -or
            $required.imageSha256.ToLowerInvariant() -cne (Hash (Join-Path $out "$name.png")) -or
            $required.method -cne 'PrintWindow(PW_RENDERFULLCONTENT); no fallback') { throw 'Required private-frame binding differs.' }
        if (@(Compare-Object ($labels|Sort-Object) (@($required.requiredLabels)|Sort-Object)).Count -ne 0 -or
            $required.nativeLabels.Count -ne $labels.Count -or $required.geometry.Hwnd -eq 0 -or
            $required.geometry.Desktop -ieq 'Default' -or $required.requiredContentBounds.Width -le 0 -or $required.requiredContentBounds.Height -le 0) { throw 'Required private content/label geometry differs.' }
        foreach ($label in $labels) {
            $node=@($required.nativeLabels|Where-Object {$_.Expected -ceq $label -and $_.ActualName -ceq $label})
            if ($node.Count -ne 1 -or $node[0].Width -le 0 -or $node[0].Height -le 0 -or
                $node[0].Left -lt $required.geometry.Left -or $node[0].Top -lt $required.geometry.Top -or
                $node[0].Left+$node[0].Width -gt $required.geometry.Right -or $node[0].Top+$node[0].Height -gt $required.geometry.Bottom) { throw 'Required owned-HWND native label is missing or clipped.' }
        }
        # OCR exceptions are solely the unchanged source-owner policy invoked by the
        # consumer. Preserve original PNG and explicit human-review qualification.
        if (@($required.ocr.MissingLabels|Where-Object {$_ -cne 'Set up your AI'}).Count -ne 0) { throw 'A non-exempt required OCR label is missing.' }
    }
    if ((Invoke-Git $Source @('rev-parse','HEAD')).Trim() -cne $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD) { throw 'UI execution changed the pinned HEAD.' }
    & git -C $Source diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { throw 'UI execution staged changes.' }
    Assert-Files $Source $files
    Assert-Files $bin $binaries 'build\ui-tests\'
    $currentFiles = @(Source-Manifest $Source)
    if (@(Compare-Object ($files.path | Sort-Object) ($currentFiles.path | Sort-Object)).Count -ne 0) { throw 'Frozen source inventory changed.' }
    Save-Json @{stage=$Stage;status='private-mounted-tests-passed-human-original-image-review-required';executed=$expected;passed=$expected;skipped=0;requiredPrivateFrames=$nativeFrames;mountedSyntheticFrames=$mountedFrames;foregroundProven=$false;keyboardProven=$false;compositorProven=$false;installerExecuted=$false;modelAcquired=$false;liveGateway=$false;freezeManifestSha256=$env:OPENCLAW_UI_PROOF_MANIFEST_SHA256} (Join-Path $out 'result.json')
} finally { Pop-Location }
