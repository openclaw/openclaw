[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Artifacts,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$AcceptedTree,
    [ValidateSet('Before','After')][string]$Stage = 'After',
    [switch]$ExecutionAuthorized,
    [switch]$BuildOnly,
    [switch]$TestsOnly,
    [switch]$PopupDiagnostic,
    [switch]$RevalidateOnly
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
$names = @('OPENCLAW_PROVIDER_ARTWORK_POPUP_DIAGNOSTIC','OPENCLAW_REPO_ROOT','OPENCLAW_TRAY_DATA_DIR','OPENCLAW_TRAY_APPDATA_DIR','OPENCLAW_TRAY_LOCALAPPDATA_DIR','OPENCLAW_UI_PROOF_DIR','OPENCLAW_UI_PROOF_FREEZE_DIR','OPENCLAW_UI_PROOF_MANIFEST_SHA256','GitVersion_NoNormalizeEnabled','GitVersion_NoFetchEnabled','OPENCLAW_PROVIDER_ARTWORK_PRIVATE_CAPTURE_JOB','OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR','OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD')
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
    if ($RevalidateOnly) {
        if ($Stage -cne 'After' -or $PopupDiagnostic) { throw 'Revalidation-only is the independently compiled After stage, never native test execution.' }
        if (@(Manifest).Count -ne $sourceFiles.Count) { throw 'After build source inventory changed.' }
        Assert-Tree
        Json @{state='After-build-source-binaries-tree-revalidated-NO-TESTS';sourceTree=$ExpectedSourceTree;candidateTree=$AcceptedTree;head=$head;Shared='RED-unwaived'} (Join-Path $Artifacts 'build-revalidated.json')
        return
    }
    $env:OPENCLAW_TRAY_DATA_DIR=Join-Path $Artifacts 'isolated-data'
    $env:OPENCLAW_TRAY_APPDATA_DIR=Join-Path $Artifacts 'isolated-roaming'
    $env:OPENCLAW_TRAY_LOCALAPPDATA_DIR=Join-Path $Artifacts 'isolated-local'
    $env:OPENCLAW_UI_PROOF_DIR=$frames
    $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR=$frames
    $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD=$head
    $env:OPENCLAW_PROVIDER_ARTWORK_PRIVATE_CAPTURE_JOB='private-mounted-v1'
    $env:OPENCLAW_UI_PROOF_FREEZE_DIR=$freeze
    $env:OPENCLAW_UI_PROOF_MANIFEST_SHA256=Hash (Join-Path $freeze 'manifest.json')
    if ($PopupDiagnostic) {
        if ($Stage -cne 'Before') { throw 'The popup observation is Before/Light only.' }
        $env:OPENCLAW_PROVIDER_ARTWORK_POPUP_DIAGNOSTIC='popup-boundary-light-v1'
        $report=Join-Path $Artifacts 'popup-boundary.trx'
        if (Test-Path $report) { throw 'Never replay or adopt an existing diagnostic report.' }
        $startedUtc=[datetime]::UtcNow
        Command 'dotnet' @('test',$project,'-c','Debug','-r','win-x64','--no-build','--no-restore','--filter','FullyQualifiedName~OnboardingAiPageTests.ProviderPopupBoundaryDiagnostic','--results-directory',$Artifacts,'--logger','trx;LogFileName=popup-boundary.trx','--blame-hang','--blame-hang-timeout','120s','--blame-hang-dump-type','none') 'popup-boundary-tests'
        . (Join-Path $Source 'scripts/TestResultContract.ps1')
        $contract=Read-TestResultContract -Path $report -StartedUtc $startedUtc -ExitCode 0
        [xml]$trx=Get-Content $report -Raw
        $rows=@($trx.SelectNodes("//*[local-name()='UnitTestResult']"))
        $counters=$trx.SelectSingleNode("//*[local-name()='Counters']")
        if ($rows.Count -ne 2 -or @($rows|Where-Object {$_.outcome -cne 'Passed'}).Count -ne 0 -or [int]$counters.executed -ne 2 -or [int]$counters.passed -ne 2) { throw 'Both controlled Light observations must execute; this is not icon qualification.' }
        Json $contract ($report+'.contract.json')
        if (@(Get-ChildItem $frames -Filter '*.png').Count -ne 2 -or @(Get-ChildItem $frames -Filter '*.required.json').Count -ne 0) { throw 'Expected exactly two raw diagnostic attempts and no qualified images.' }
        $phases=@('before-open','opened-and-mounted','owner-before-move','owner-after-move','owner-after-composition','owner-before-printwindow','owner-after-printwindow','after-owner-return','test-finally-before-close')
        foreach ($arm in @('same-position-move','conditional-move')) {
            $name='popup-'+$arm+'-Light'
            $raw=Get-Content (Join-Path $frames ($name+'.json')) -Raw|ConvertFrom-Json
            $trace=Get-Content (Join-Path $frames ($name+'.boundary.json')) -Raw|ConvertFrom-Json
            $assemblyHash=Hash (Join-Path $bin 'OpenClaw.Tray.UITests.dll')
            if ($raw.head -cne $head -or $raw.method -cne 'PrintWindow(PW_RENDERFULLCONTENT); no fallback' -or $raw.imageSha256 -cne (Hash (Join-Path $frames ($name+'.png'))) -or $raw.assemblySha256 -cne $assemblyHash) { throw 'Raw observation image/source/assembly binding differs.' }
            if ($trace.schema -cne 'provider-popup-boundary-observation-v1' -or $trace.state -cne 'observed-not-qualified' -or $trace.Arm -cne $arm -or $trace.head -cne $head -or $trace.assemblySha256 -cne $assemblyHash -or $trace.freezeManifestSha256 -cne $env:OPENCLAW_UI_PROOF_MANIFEST_SHA256 -or ($trace.events.phase -join '|') -cne ($phases -join '|')) { throw 'Incomplete or misbound causal boundary observation.' }
            foreach ($event in $trace.events) {
                if ($event.sourcePid -le 0 -or $event.sourceThread -le 0 -or $event.sourceHwnd -eq 0 -or $event.desktop -ieq 'Default' -or $event.rows.Count -ne 4) { throw 'Invalid private owned observation identity.' }
                foreach ($owned in $event.ownedDesktopWindows) {
                    if ($owned.pid -ne $event.sourcePid -or $owned.thread -le 0 -or $owned.desktop -cne $event.desktop) { throw 'Observation expanded beyond the owned PID on the same private desktop.' }
                }
            }
        }
        if (@(Manifest).Count -ne $sourceFiles.Count) { throw 'Diagnostic source inventory changed.' }
        foreach ($file in $sourceFiles) { if ((Hash (Join-Path $Source $file.path)) -cne $file.sha256) { throw 'Diagnostic source drift.' } }
        foreach ($file in $binaryFiles) { if ((Hash (Join-Path $bin $file.path.Substring(15))) -cne $file.sha256) { throw 'Diagnostic binary drift.' } }
        Assert-Tree
        Json @{state='controlled-observations-collected-NOT-QUALIFICATION';head=$head;sourceTree=$ExpectedSourceTree;candidateTree=$AcceptedTree;executed=2;passed=2;skipped=0;rawAttempts=2;qualifiedFrames=0;theme='Light';Dark='UNRUN';Shared='RED-unwaived';manualPixels='required for both arms, never select the best arm';outcome='parent must classify closure versus separate HWND or inconclusive; no automatic fix/qualification'} (Join-Path $Artifacts 'diagnostic-result.json')
        return
    }
    throw 'This diagnostic packet cannot execute qualification selections.'
} catch {
    Json @{state='failed';error=($_ | Out-String);candidateTree=$AcceptedTree;Shared='RED-unwaived'} (Join-Path $Artifacts 'failure.json')
    throw
} finally {
    Pop-Location
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$old[$name]) }
    Json @(Get-ChildItem -LiteralPath $Artifacts -Recurse -File | Where-Object {$_.Name -ne 'artifact-hashes.json'} | ForEach-Object { @{path=[IO.Path]::GetRelativePath($Artifacts,$_.FullName);bytes=$_.Length;sha256=(Hash $_.FullName)} }) (Join-Path $Artifacts 'artifact-hashes.json')
}
