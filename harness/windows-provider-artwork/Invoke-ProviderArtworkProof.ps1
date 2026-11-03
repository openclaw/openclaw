[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Artifacts,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$AcceptedTree,
    [ValidateSet('Before','After')][string]$Stage = 'After',
    [switch]$ExecutionAuthorized,
    [switch]$BuildOnly,
    [switch]$TestsOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
# ValidateSet accepts case-insensitively. Canonicalize before selecting any source,
# patch, filter or frame name so accepted casing cannot change stage provenance.
$Stage = if ($Stage -ieq 'Before') { 'Before' } else { 'After' }
# Preparation is not execution authority. The parent must select and authorize
# an isolated Windows host before invoking this packet. This driver never allocates,
# installs runtimes, changes a desktop/resolution, or mutates GitHub/configuration.
if (!$ExecutionAuthorized -or !$IsWindows) { throw 'Requires separate native-execution authorization and a qualified Windows host.' }
if ([bool]$BuildOnly -eq [bool]$TestsOnly) { throw 'Select exactly BuildOnly (ordinary source build) or TestsOnly (prepared private desktop).' }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Json($Value, [string]$Path) { ConvertTo-Json -InputObject $Value -Depth 16 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM }
function Git([string[]]$Arguments) {
    # Function names are case-insensitive; an unqualified git call recurses here.
    $application = @(Get-Command git -CommandType Application -ErrorAction Stop)[0]
    $value = & $application.Source -C $Source @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Git source query failed. Do not change safe.directory or ownership to bypass this guard.' }
    $value
}
function Manifest {
    @(Git @('-c','core.quotepath=false','ls-files','--cached','--others','--exclude-standard') |
        Sort-Object -Unique | ForEach-Object { @{path=$_;sha256=(Hash (Join-Path $Source $_))} })
}
function Assert-Tree {
    $previous = $env:GIT_INDEX_FILE
    $index = Join-Path $Artifacts ('candidate-' + [guid]::NewGuid().ToString('N') + '.index')
    try {
        $env:GIT_INDEX_FILE = $index
        Git @('read-tree','HEAD') | Out-Null
        Git @('add','-u') | Out-Null
        if ((Git @('write-tree')).Trim() -cne $ExpectedSourceTree) { throw 'Complete source tree differs from the accepted candidate.' }
    } finally { $env:GIT_INDEX_FILE = $previous }
}
function Command([string]$Executable, [string[]]$Arguments, [string]$Name) {
    $started = [DateTimeOffset]::UtcNow
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $priorNative = $PSNativeCommandUseErrorActionPreference
    $priorError = $ErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    $ErrorActionPreference = 'Continue'
    try {
        & $Executable @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $Artifacts ($Name + '.log')) | Out-Host
        $exit = $LASTEXITCODE
    } finally { $PSNativeCommandUseErrorActionPreference=$priorNative; $ErrorActionPreference=$priorError }
    Json @{name=$Name;startedUtc=$started;endedUtc=[DateTimeOffset]::UtcNow;wallSeconds=$clock.Elapsed.TotalSeconds;exitCode=$exit;command=(@($Executable)+$Arguments)-join ' '} (Join-Path $Artifacts ($Name+'.json'))
    if ($exit -ne 0) { throw "$Name failed. Stop at this exact leaf; no dependency, Reactor, analyzer or helper-name workaround is authorized." }
}
$Source = (Resolve-Path -LiteralPath $Source).Path
$Artifacts = [IO.Path]::GetFullPath($Artifacts)
if ($BuildOnly -and (Test-Path -LiteralPath $Artifacts)) { throw 'Choose a fresh artifact destination; stale reports are not admitted.' }
if ($TestsOnly -and !(Test-Path -LiteralPath $Artifacts)) { throw 'TestsOnly requires the separately prepared build/freeze.' }
if ($Artifacts.StartsWith($Source.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Artifacts must be outside source.' }
$session = (Get-Process -Id $PID).SessionId
if ($session -eq 0) { throw 'Native foreground proof cannot run from session 0.' }
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'source-pins.json') -Raw | ConvertFrom-Json
if ($AcceptedTree -cne $pin.candidateTree) { throw 'Parent-accepted tree does not match this packet.' }
foreach ($file in $pin.packetFiles.PSObject.Properties) {
    if ((Hash (Join-Path $PSScriptRoot $file.Name)) -cne $file.Value.ToUpperInvariant()) { throw "Packet seal mismatch: $($file.Name)" }
}
if ($BuildOnly -and @(Git @('status','--porcelain')).Count -ne 0) { throw 'Use a new clean task-owned source checkout.' }
if ($BuildOnly) { New-Item -ItemType Directory -Path $Artifacts | Out-Null }
$head = (Git @('rev-parse','HEAD')).Trim()
$ExpectedSourceTree = if ($Stage -ceq 'Before') { $pin.baselineCaptureTree } else { $pin.afterCaptureTree }
$changedFiles = if ($Stage -ceq 'Before') { $pin.baselineChangedFiles } else { $pin.afterCaptureChangedFiles }
if ($BuildOnly) {
if ($Stage -ceq 'Before') {
    if ($head -cne $pin.baseCommit) { throw 'Before requires the exact clean W4 base; candidate production sources are not admitted.' }
    $patch = Join-Path $PSScriptRoot 'baseline-capture.patch'
    Git @('apply','--check','--whitespace=error',$patch) | Out-Null
    Git @('apply','--whitespace=error',$patch) | Out-Null
} elseif ($head -ceq $pin.baseCommit) {
    Git @('apply','--check','--whitespace=error',(Join-Path $PSScriptRoot 'candidate.patch')) | Out-Null
    Git @('apply','--whitespace=error',(Join-Path $PSScriptRoot 'candidate.patch')) | Out-Null
} elseif ((Git @('rev-parse','HEAD^{tree}')).Trim() -cne $AcceptedTree) {
    throw 'Source is neither the exact W4 base nor a clean commit of the accepted tree.'
}
if ($Stage -ceq 'After') {
    # Admit canonical product/test bytes BEFORE the separately sealed proof overlay.
    $proofTree=$ExpectedSourceTree
    $ExpectedSourceTree=$AcceptedTree
    try { Assert-Tree } finally { $ExpectedSourceTree=$proofTree }
    $overlay=Join-Path $PSScriptRoot 'after-private-capture.patch'
    Git @('apply','--check','--whitespace=error',$overlay) | Out-Null
    Git @('apply','--whitespace=error',$overlay) | Out-Null
}
}
Assert-Tree
foreach ($file in $changedFiles) {
    if ((Hash (Join-Path $Source $file.path)) -cne $file.afterSha256.ToUpperInvariant()) { throw "Postimage mismatch: $($file.path)" }
}
Push-Location $Source
try { $sdk = (& dotnet --version).Trim() } finally { Pop-Location }
if ($sdk -cne '10.0.403') { throw 'The exact qualified .NET SDK 10.0.403 is required; source global.json remains unchanged.' }
[xml]$props=Get-Content (Join-Path $Source 'Directory.Build.props') -Raw
$runtimeVersion=$props.SelectSingleNode('/Project/PropertyGroup/MicrosoftWindowsAppSDKVersion').InnerText.Trim()
if ($runtimeVersion -cne '2.6.4') { throw 'Source-owned Windows App SDK version differs from the qualified 2.6.4 contract.' }
# Qualified signed-installer/AppX receipts establish family .2, not channel .2.6.
$runtimeFamily='Microsoft.WindowsAppRuntime.'+([version]$runtimeVersion).Major
$minimumRuntime=[version]($runtimeVersion+'.0')
$runtime = @(Get-AppxPackage -Name $runtimeFamily | Where-Object { $_.Name -ceq $runtimeFamily -and $_.Architecture.ToString() -ceq 'X64' -and $_.Status.ToString() -ceq 'Ok' -and $_.IsFramework -and [version]$_.Version -ge $minimumRuntime -and $_.Publisher -match 'CN=Microsoft Corporation' })
if ($runtime.Count -eq 0) { throw "Source-declared $runtimeFamily x64 framework >= $minimumRuntime is not registered for this user. Runtime provisioning belongs to the reviewed CI initializer." }
Json @{head=$head;candidateTree=$AcceptedTree;sdk=$sdk;sessionId=$session;runtime=@($runtime | Select-Object PackageFullName,Version,Architecture);state='prerequisites-observed'} (Join-Path $Artifacts 'prerequisites.json')
$names = @('OPENCLAW_REPO_ROOT','OPENCLAW_TRAY_DATA_DIR','OPENCLAW_TRAY_APPDATA_DIR','OPENCLAW_TRAY_LOCALAPPDATA_DIR','OPENCLAW_UI_PROOF_DIR','OPENCLAW_UI_PROOF_FREEZE_DIR','OPENCLAW_UI_PROOF_MANIFEST_SHA256','GitVersion_NoNormalizeEnabled','GitVersion_NoFetchEnabled','OPENCLAW_PROVIDER_ARTWORK_PRIVATE_CAPTURE_JOB','OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR','OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD')
$old = @{}
foreach ($name in $names) { $old[$name]=[Environment]::GetEnvironmentVariable($name) }
Push-Location $Source
try {
    $env:OPENCLAW_REPO_ROOT=$Source
    $env:GitVersion_NoNormalizeEnabled='true'
    $env:GitVersion_NoFetchEnabled='true'
    $project='tests/OpenClaw.Tray.UITests/OpenClaw.Tray.UITests.csproj'
    $freeze=Join-Path $Artifacts 'freeze'
    $frames=Join-Path $Artifacts 'frames'
    $bin=Join-Path $Source 'tests/OpenClaw.Tray.UITests/bin/Debug/net10.0-windows10.0.22621.0/win-x64'
    if ($BuildOnly) {
    Command 'dotnet' @('restore',$project,'-r','win-x64') 'ui-restore'
    Command 'dotnet' @('build',$project,'-c','Debug','-r','win-x64','--no-restore','-p:WriteVersionInfoToBuildLog=false') 'ui-build'
    Command (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-File',(Join-Path $PSScriptRoot 'Save-CalculatedVersion.ps1'),'-Source',$Source,'-Artifacts',$Artifacts,'-Stage',$Stage) 'calculated-version'
    Assert-Tree
    New-Item -ItemType Directory -Path $freeze,$frames | Out-Null
    $sourceFiles=@(Manifest)
    Json $sourceFiles (Join-Path $freeze 'full-source-manifest.json')
    $bin=Join-Path $Source 'tests/OpenClaw.Tray.UITests/bin/Debug/net10.0-windows10.0.22621.0/win-x64'
    $binaryFiles=@(Get-ChildItem -LiteralPath $bin -File | Sort-Object Name | ForEach-Object { @{path=('build\ui-tests\'+$_.Name);sha256=(Hash $_.FullName)} })
    if ($binaryFiles.Count -eq 0) { throw 'UI build emitted no binaries.' }
    Json $binaryFiles (Join-Path $freeze 'build-manifest.json')
    Json @{head=$head;candidateTree=$AcceptedTree;fullSourceManifestSha=(Hash (Join-Path $freeze 'full-source-manifest.json'));buildManifestSha=(Hash (Join-Path $freeze 'build-manifest.json'))} (Join-Path $freeze 'manifest.json')
    Json @{state='build-and-freeze-prepared';head=$head;stage=$Stage;sourceTree=$ExpectedSourceTree;candidateTree=$AcceptedTree;driverSha256=(Hash $PSCommandPath);manifestSha256=(Hash (Join-Path $freeze 'manifest.json'))} (Join-Path $Artifacts 'prepared.json')
    return
    }
    $prepared=Get-Content (Join-Path $Artifacts 'prepared.json') -Raw | ConvertFrom-Json
    if ($prepared.state -cne 'build-and-freeze-prepared' -or $prepared.head -cne $head -or $prepared.stage -cne $Stage -or $prepared.sourceTree -cne $ExpectedSourceTree -or $prepared.candidateTree -cne $AcceptedTree -or $prepared.driverSha256 -cne (Hash $PSCommandPath) -or $prepared.manifestSha256 -cne (Hash (Join-Path $freeze 'manifest.json'))) { throw 'Prepared build identity differs from this stage/source/driver.' }
    if (Test-Path (Join-Path $Artifacts 'result.json')) { throw 'This prepared native selection already completed; do not replay it.' }
    $sourceFiles=@(Get-Content (Join-Path $freeze 'full-source-manifest.json') -Raw | ConvertFrom-Json)
    $binaryFiles=@(Get-Content (Join-Path $freeze 'build-manifest.json') -Raw | ConvertFrom-Json)
    foreach ($file in $sourceFiles) { if ((Hash (Join-Path $Source $file.path)) -cne $file.sha256) { throw 'Prepared source drift before native execution.' } }
    foreach ($file in $binaryFiles) { if ((Hash (Join-Path $bin $file.path.Substring(15))) -cne $file.sha256) { throw 'Prepared binary drift before native execution.' } }
    $env:OPENCLAW_TRAY_DATA_DIR=Join-Path $Artifacts 'isolated-data'
    $env:OPENCLAW_TRAY_APPDATA_DIR=Join-Path $Artifacts 'isolated-roaming'
    $env:OPENCLAW_TRAY_LOCALAPPDATA_DIR=Join-Path $Artifacts 'isolated-local'
    $env:OPENCLAW_UI_PROOF_DIR=$frames
    $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR=$frames
    $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD=$head
    $env:OPENCLAW_PROVIDER_ARTWORK_PRIVATE_CAPTURE_JOB='private-mounted-v1'
    $env:OPENCLAW_UI_PROOF_FREEZE_DIR=$freeze
    $env:OPENCLAW_UI_PROOF_MANIFEST_SHA256=Hash (Join-Path $freeze 'manifest.json')
    $filter='FullyQualifiedName~OnboardingAiPageTests.ProviderPicker_ShowsAdvertisedBrandsAndHonestFallbacksWithoutStartingSetup|FullyQualifiedName~OnboardingAiPageTests.ProviderDialog_KeepsSelectedArtworkThroughTypedPromptsAndReleasesOnlyItsBorrow|FullyQualifiedName~OnboardingArtworkRenderingTests.ProviderArtwork_RebindingDetachesThePreviousSessionWithoutClosingTheBorrowedReplacement'
    $expectedCases = 7
    $framePrefix = ''
    if ($Stage -ceq 'Before') {
        $filter='FullyQualifiedName~OnboardingAiPageTests.BeforeArtworkPicker|FullyQualifiedName~OnboardingAiPageTests.BeforeArtworkDialog'
        $expectedCases=6
        $framePrefix='before-'
    }
    $selections=@(@{name='candidate-dialog';filter='FullyQualifiedName~OnboardingAiPageTests.ProviderDialog_KeepsSelectedArtworkThroughTypedPromptsAndReleasesOnlyItsBorrow';cases=4},
        @{name='candidate-picker-lifetime';filter='FullyQualifiedName~OnboardingAiPageTests.ProviderPicker_ShowsAdvertisedBrandsAndHonestFallbacksWithoutStartingSetup|FullyQualifiedName~OnboardingArtworkRenderingTests.ProviderArtwork_RebindingDetachesThePreviousSessionWithoutClosingTheBorrowedReplacement';cases=3})
    if ($Stage -ceq 'Before') {
        # The original picker is the named unknown leaf. Do not spend the dialog
        # selection after a genuine popup/occlusion/PrintWindow failure here.
        $selections=@(@{name='before-picker';filter='FullyQualifiedName~OnboardingAiPageTests.BeforeArtworkPicker';cases=2},
            @{name='before-dialog';filter='FullyQualifiedName~OnboardingAiPageTests.BeforeArtworkDialog';cases=4})
    }
    . (Join-Path $Source 'scripts/TestResultContract.ps1')
    $cases=@()
    foreach ($selection in $selections) {
        $report=Join-Path $Artifacts ($selection.name+'.trx')
        if (Test-Path $report) { throw 'A selected native report already exists; do not retry uncertain/failed work.' }
        $startedUtc=[datetime]::UtcNow
        Command 'dotnet' @('test',$project,'-c','Debug','-r','win-x64','--no-build','--no-restore','--filter',$selection.filter,'--results-directory',$Artifacts,'--logger',('trx;LogFileName='+$selection.name+'.trx'),'--blame-hang','--blame-hang-timeout','120s','--blame-hang-dump-type','none') ($selection.name+'-tests')
        $contract=Read-TestResultContract -Path $report -StartedUtc $startedUtc -ExitCode 0
        [xml]$trx=Get-Content -LiteralPath $report -Raw
        $rows=@($trx.SelectNodes("//*[local-name()='UnitTestResult']"))
        $counters=$trx.SelectSingleNode("//*[local-name()='Counters']")
        if ($rows.Count -ne $selection.cases -or @($rows | Where-Object {$_.outcome -cne 'Passed'}).Count -ne 0 -or [int]$counters.executed -ne $selection.cases -or [int]$counters.passed -ne $selection.cases) { throw 'Every selected stage case must execute and pass with zero skips.' }
        Json $contract ($report+'.contract.json')
        $cases += $rows
    }
    if ($cases.Count -ne $expectedCases) { throw 'Stage aggregate case inventory differs.' }
    $expectedFrames=@("${framePrefix}provider-inventory-parent-Light","${framePrefix}provider-inventory-popup-Light","${framePrefix}provider-inventory-parent-Dark","${framePrefix}provider-inventory-popup-Dark")
    foreach ($brand in @('llama-app','ollama')) { foreach ($theme in @('Light','Dark')) { foreach ($step in @('note','text','confirm')) { $expectedFrames += "${framePrefix}provider-$brand-$step-$theme" } } }
    if (@(Get-ChildItem -LiteralPath $frames -Filter '*.png').Count -ne $expectedFrames.Count) { throw 'Incomplete or extra frame inventory.' }
    foreach ($name in $expectedFrames) {
        $image=Join-Path $frames ($name+'.png')
        $receipt=Get-Content (Join-Path $frames ($name+'.json')) -Raw | ConvertFrom-Json
        $required=Get-Content (Join-Path $frames ($name+'.required.json')) -Raw | ConvertFrom-Json
        $assemblyHash=Hash (Join-Path $bin 'OpenClaw.Tray.UITests.dll')
        if ($receipt.head -cne $head -or $receipt.method -cne 'PrintWindow(PW_RENDERFULLCONTENT); no fallback' -or
            (Hash $image) -cne $receipt.imageSha256 -or $receipt.assemblySha256 -cne $assemblyHash -or
            $receipt.qualification -cne 'Synthetic dependencies; private owned production window. Not native compositor, keyboard, installed-app, or live Gateway proof.') { throw "Private mounted image binding failed: $name" }
        if ($required.schema -cne 'provider-artwork-private-mounted-required-v2' -or $required.state -cne $name -or
            $required.head -cne $head -or $required.freezeManifestSha256 -cne $env:OPENCLAW_UI_PROOF_MANIFEST_SHA256 -or
            $required.assemblySha256 -cne $assemblyHash -or $required.imageSha256 -cne (Hash $image) -or
            $required.method -cne 'PrintWindow(PW_RENDERFULLCONTENT); no fallback') { throw 'Required private-frame/source/freeze/assembly binding differs.' }
        if ($name -like '*-inventory-popup-*') { $labels=@('Llama app','Ollama','llama.cpp','Unknown provider') }
        elseif ($name -like '*-inventory-parent-*') { $labels=@('API key provider','API key or token') }
        else {
            $match=[regex]::Match($name,'^(?:before-)?provider-(llama-app|ollama)-(note|text|confirm)-(Light|Dark)$')
            if (!$match.Success) { throw 'Unknown private frame.' }
            $label=if($match.Groups[1].Value -ceq 'llama-app'){'Llama app'}else{'Ollama'}
            $labels=@($label,('Provider '+$match.Groups[2].Value),'Cancel')
        }
        $target=$required.captureTarget
        $attempt=Get-Content (Join-Path $frames ($name+'.attempt.json')) -Raw|ConvertFrom-Json
        if ($required.processId -le 0 -or $required.uiThreadId -le 0 -or $target.Hwnd -eq 0 -or
            $receipt.hwnd -ne $target.Hwnd -or $attempt.hwnd -ne $target.Hwnd -or
            $attempt.ownerProcessId -ne $required.processId -or $attempt.desktop -cne $required.geometry.Desktop -or
            $receipt.parentHwnd -ne $required.geometry.Hwnd -or $attempt.parentHwnd -ne $required.geometry.Hwnd -or
            $attempt.left -ne $target.Left -or $attempt.top -ne $target.Top -or $attempt.right -ne $target.Right -or $attempt.bottom -ne $target.Bottom -or
            $receipt.width -ne ($target.Right - $target.Left) -or $receipt.height -ne ($target.Bottom - $target.Top)) { throw 'Required original capture target/PID/geometry binding differs.' }
        if ($name -like '*-inventory-popup-*') {
            $popup=$required.popupAdmission
            if ($required.targetKind -cne 'owned-combobox-popup' -or $popup.hwnd -ne $target.Hwnd -or
                $popup.parentHwnd -ne $required.geometry.Hwnd -or $popup.hwnd -eq $popup.parentHwnd -or
                $popup.ProcessId -ne $required.processId -or $popup.ThreadId -ne $required.uiThreadId -or
                $popup.Desktop -cne $required.geometry.Desktop -or $popup.className -cne 'Microsoft.UI.Content.PopupWindowSiteBridge' -or
                !$popup.xamlPopupOpen -or $popup.OwnerChain.Count -ne 1 -or $popup.OwnerChain[0] -ne $popup.parentHwnd -or $popup.Rows.Count -ne 4 -or
                $popup.Bounds.Left -ne $target.Left -or $popup.Bounds.Top -ne $target.Top -or $popup.Bounds.Right -ne $target.Right -or $popup.Bounds.Bottom -ne $target.Bottom) { throw 'Owned real ComboBox popup admission differs.' }
            foreach ($row in $popup.Rows) {
                if ($row.Width -le 0 -or $row.Height -le 0 -or $row.Left -lt $target.Left -or $row.Top -lt $target.Top -or
                    $row.Left+$row.Width -gt $target.Right -or $row.Top+$row.Height -gt $target.Bottom) { throw 'A real provider row is missing or clipped in its popup HWND.' }
            }
        } elseif ($required.targetKind -cne 'parent' -or $null -ne $required.popupAdmission -or $target.Hwnd -ne $required.geometry.Hwnd -or
            $target.Left -ne $required.geometry.Left -or $target.Top -ne $required.geometry.Top -or $target.Right -ne $required.geometry.Right -or $target.Bottom -ne $required.geometry.Bottom) { throw 'Parent frame must retain its original parent target.' }
        if (@(Compare-Object ($labels|Sort-Object) (@($required.requiredLabels)|Sort-Object)).Count -ne 0 -or
            $required.nativeLabels.Count -ne $labels.Count -or $required.geometry.Hwnd -eq 0 -or
            $required.geometry.Desktop -ieq 'Default' -or $required.requiredContentBounds.Width -le 0 -or
            $required.requiredContentBounds.Height -le 0) { throw 'Required private content/label geometry differs.' }
        foreach ($label in $labels) {
            $node=@($required.nativeLabels|Where-Object {$_.Expected -ceq $label -and $_.ActualName -ceq $label})
            if ($node.Count -ne 1 -or $node[0].Width -le 0 -or $node[0].Height -le 0 -or
                $node[0].Left -lt $target.Left -or $node[0].Top -lt $target.Top -or
                $node[0].Left+$node[0].Width -gt $target.Right -or
                $node[0].Top+$node[0].Height -gt $target.Bottom) { throw 'Required owned-HWND label is missing or clipped.' }
        }
        if (@($required.ocr.MissingLabels).Count -ne 0) { throw 'A required icon-matrix OCR label is missing; no new exception is admitted.' }
    }
    if (@(Manifest).Count -ne $sourceFiles.Count) { throw 'Frozen source inventory changed.' }
    if ($Stage -ceq 'After') {
        if (@(Get-ChildItem $frames -Filter '*.dialog-uia.json' -File).Count -ne 12) { throw 'Expected all twelve actual dialog role/name observations.' }
        foreach ($brand in @('llama-app','ollama')) { foreach ($theme in @('Light','Dark')) { foreach ($step in @('note','text','confirm')) {
            $state='provider-'+$brand+'-'+$step+'-'+$theme
            $nameReceipt=Get-Content (Join-Path $frames ($state+'.dialog-uia.json')) -Raw | ConvertFrom-Json
            if ($nameReceipt.schema -cne 'owned-native-dialog-name-v1' -or $nameReceipt.providerGeometryContract -cne 'rendered-in-native-in-measured-slot-physical-pixels' -or $nameReceipt.state -cne $state -or $nameReceipt.status -cne 'name-verified' -or
                !$nameReceipt.openedObserved -or $nameReceipt.expectedName -cne ('Provider '+$step) -or $nameReceipt.selected.Name -cne $nameReceipt.expectedName -or
                $nameReceipt.selected.Role -cne 'ControlType.Window' -or $nameReceipt.selected.ClassName -cne 'Popup' -or !$nameReceipt.selected.IsModal -or $nameReceipt.selected.IsOffscreen -or
                $nameReceipt.selected.ProcessId -ne $nameReceipt.ProcessId -or $nameReceipt.selected.RuntimeId.Count -eq 0 -or
                $null -eq $nameReceipt.RenderedProviderBounds -or $null -eq $nameReceipt.ProviderLayoutSlotInParent -or $null -eq $nameReceipt.ProviderLayoutSlotBounds -or
                $nameReceipt.ProviderLayoutSlotInParent.Right -le $nameReceipt.ProviderLayoutSlotInParent.Left -or $nameReceipt.ProviderLayoutSlotInParent.Bottom -le $nameReceipt.ProviderLayoutSlotInParent.Top -or
                $nameReceipt.ProviderLayoutSlotBounds.Left -gt $nameReceipt.RenderedProviderBounds.Left -or $nameReceipt.ProviderLayoutSlotBounds.Top -gt $nameReceipt.RenderedProviderBounds.Top -or
                $nameReceipt.ProviderLayoutSlotBounds.Right -lt $nameReceipt.RenderedProviderBounds.Right -or $nameReceipt.ProviderLayoutSlotBounds.Bottom -lt $nameReceipt.RenderedProviderBounds.Bottom -or
                $nameReceipt.observed.Overflow -or $nameReceipt.observed.Errors.Count -ne 0 -or
                $nameReceipt.head -cne $head -or $nameReceipt.freezeManifestSha256 -cne $env:OPENCLAW_UI_PROOF_MANIFEST_SHA256 -or
                $nameReceipt.assemblySha256 -cne (Hash (Join-Path $bin 'OpenClaw.Tray.UITests.dll'))) { throw 'Actual owned native dialog role/name receipt is absent or unverified.' }
        } } }
    }
    foreach ($file in $sourceFiles) { if ((Hash (Join-Path $Source $file.path)) -cne $file.sha256) { throw "Source drift: $($file.path)" } }
    foreach ($file in $binaryFiles) { if ((Hash (Join-Path $bin $file.path.Substring(15))) -cne $file.sha256) { throw "Binary drift: $($file.path)" } }
    Assert-Tree
    Json @{state='private-mounted-cases-passed-manual-pixel-review-required';foregroundProven=$false;keyboardProven=$false;compositorProven=$false;head=$head;stage=$Stage;candidateTree=$AcceptedTree;sourceTree=$ExpectedSourceTree;executed=$expectedCases;passed=$expectedCases;skipped=0;frames=$expectedFrames;Shared='RED-unwaived';fullBuild='not executed by this narrow driver';priorW4='unchanged-contract evidence only; not current-tree aggregate proof';popup='Separate original parent form and exactly admitted owned popup per theme; no composite/AX-only/unowned fallback'} (Join-Path $Artifacts 'result.json')
} catch {
    Json @{state='failed';error=($_ | Out-String);candidateTree=$AcceptedTree;Shared='RED-unwaived'} (Join-Path $Artifacts 'failure.json')
    throw
} finally {
    Pop-Location
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$old[$name]) }
    Json @(Get-ChildItem -LiteralPath $Artifacts -Recurse -File | Where-Object {$_.Name -ne 'artifact-hashes.json'} | ForEach-Object { @{path=[IO.Path]::GetRelativePath($Artifacts,$_.FullName);bytes=$_.Length;sha256=(Hash $_.FullName)} }) (Join-Path $Artifacts 'artifact-hashes.json')
}
