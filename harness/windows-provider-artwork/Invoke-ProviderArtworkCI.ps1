[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BeforeSource,
    [Parameter(Mandatory)][string]$AfterSource,
    [Parameter(Mandatory)][string]$Artifacts,
    [Parameter(Mandatory)][string]$AstReceipt,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPayloadSha256,
    [Parameter(Mandatory)][string]$Qualification,
    [switch]$ExecutionAuthorized
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$true
if (!$ExecutionAuthorized -or !$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_REF -cne 'refs/heads/roboclaw/local-ai-native-followups-20261102' -or $Qualification -cne 'native-icons-w5-owned-popup-v1') { throw 'Only the parent-authorized, reviewed manual Windows CI qualification is admitted.' }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Json($Value,[string]$Path) { ConvertTo-Json -InputObject $Value -Depth 16 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM }
$manifestPath=Join-Path $PSScriptRoot 'payload-manifest.json'
if ((Hash $manifestPath) -cne $ExpectedPayloadSha256) { throw 'Workflow-reviewed payload manifest does not match.' }
$manifest=Get-Content $manifestPath -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) { if ((Hash (Join-Path $PSScriptRoot $file.path)) -cne $file.sha256) { throw "Payload mismatch: $($file.path)" } }
$actual=@(Get-ChildItem $PSScriptRoot -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($PSScriptRoot,$_.FullName).Replace('\','/') } | Sort-Object)
$expected=@(@($manifest.files.path)+@('payload-manifest.json','workflow-job.yml','workflow-input-choice.yml') | Sort-Object)
if (@(Compare-Object $expected $actual).Count -ne 0) { throw 'Unexpected execution payload inventory.' }
$ast=Get-Content -LiteralPath $AstReceipt -Raw | ConvertFrom-Json
if ($ast.state -cne 'packet-parse-and-stage-normalization-passed' -or $ast.cases -ne 8 -or $ast.runId -cne $env:GITHUB_RUN_ID) { throw 'First CI AST/stage preflight did not pass in this run.' }
$scriptFiles=@(Get-ChildItem $PSScriptRoot -File -Filter '*.ps1')
if ($ast.parsedFiles.Count -ne $scriptFiles.Count) { throw 'AST preflight did not cover the full script set.' }
foreach ($file in $ast.parsedFiles) { if ((Hash (Join-Path $PSScriptRoot $file.path)) -cne $file.sha256.ToLowerInvariant()) { throw 'Script changed after AST/stage admission.' } }
$pin=Get-Content (Join-Path $PSScriptRoot 'source-pins.json') -Raw | ConvertFrom-Json
if ($ast.nativeGitSmoke.state -cne 'passed' -or $ast.nativeGitSmoke.expectedSha -cne '23dac5b69b37a75f3a4c111044a841b8a6b76761' -or $ast.nativeGitSmoke.observedSha -cne $ast.nativeGitSmoke.expectedSha -or $ast.nativeGitSmoke.driverFunctionSha256 -cne $pin.nativeGitWrapperSha256) { throw 'First CI preflight did not prove the current driver native Git wrapper.' }
if ($pin.candidateTree -cne '746f015b26b6144f0743a488334d4dfe5ff3e52a' -or $pin.baseCommit -cne 'c550174d517b5e8830726cd5c32d4e132c144659') { throw 'Parent-reviewed product source pins differ.' }
$BeforeSource=(Resolve-Path $BeforeSource).Path
$AfterSource=(Resolve-Path $AfterSource).Path
$Artifacts=[IO.Path]::GetFullPath($Artifacts)
if (Test-Path $Artifacts) { throw 'Use a fresh qualification result root.' }
if ($BeforeSource -ieq $AfterSource) { throw 'Before and After require separate owned checkouts.' }
foreach ($source in @($BeforeSource,$AfterSource)) {
    if ($Artifacts.StartsWith($source.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Qualification artifacts must be outside source.' }
}
foreach ($source in @($BeforeSource,$AfterSource)) {
    $head=& git -C $source rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $head.Trim() -cne $pin.baseCommit) { throw 'Expected exact W4 source base.' }
    $dirty=@(& git -C $source status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Expected a fresh clean owned source checkout.' }
    foreach ($relative in @('Directory.Build.props','global.json')) {
        $row=@($manifest.sourceContracts | Where-Object {$_.path -ceq $relative})
        if ($row.Count -ne 1 -or (Hash (Join-Path $source $relative)) -cne $row[0].sha256) { throw 'Source-owned runtime/SDK contract differs.' }
    }
}
New-Item -ItemType Directory -Path $Artifacts | Out-Null
Copy-Item $AstReceipt (Join-Path $Artifacts 'ast-stage-preflight.json')
$leaf='runtime-admission'
try {
    $runtimeOut=Join-Path $Artifacts 'runtime'
    New-Item -ItemType Directory -Path $runtimeOut | Out-Null
    & (Join-Path $PSScriptRoot 'Initialize-NativeRuntime.ps1') -BeforeSource $BeforeSource -AfterSource $AfterSource -Artifacts $runtimeOut -ExecutionAuthorized
    $leaf='After-current-UI-build-first'
    # Compile candidate production and its required test owner/overlay before
    # spending native work on the newly admitted popup PrintWindow leaf.
    & (Join-Path $PSScriptRoot 'Invoke-ProviderArtworkProof.ps1') -Source $AfterSource -Artifacts (Join-Path $Artifacts 'After') -Stage After -AcceptedTree $pin.candidateTree -ExecutionAuthorized -BuildOnly
    foreach ($stage in @('Before','After')) {
        $source=if ($stage -ceq 'Before') { $BeforeSource } else { $AfterSource }
        $out=Join-Path $Artifacts $stage
        $leaf="$stage-current-UI-build"
        # The source-owned ordinary build runs on the qualified user's normal
        # desktop. Only the native test/capture phase uses its private desktop.
        if ($stage -ceq 'Before') { & (Join-Path $PSScriptRoot 'Invoke-ProviderArtworkProof.ps1') -Source $source -Artifacts $out -Stage $stage -AcceptedTree $pin.candidateTree -ExecutionAuthorized -BuildOnly }
        $leaf="$stage-private-native-tests"
        $driver=Join-Path $PSScriptRoot 'Invoke-ProviderArtworkProof.ps1'
        $line='-NoProfile -NonInteractive -File "'+$driver+'" -Source "'+$source+'" -Artifacts "'+$out+'" -Stage '+$stage+' -AcceptedTree '+$pin.candidateTree+' -ExecutionAuthorized -TestsOnly'
        $launch=Join-Path $Artifacts ($stage+'-private-desktop.json')
        $launchArgs=@{Executable=(Join-Path $PSHOME 'pwsh.exe');ArgumentLine=$line;DataDirectory=(Join-Path $out 'isolated-data');McpPort=18789;ConsoleProcess=$true;WaitForExit=$true;ProcessTimeoutSeconds=1800;NamePrefix=('ProviderArtwork'+$stage);ResultPath=$launch}
        & (Join-Path $source 'scripts/Invoke-PrivateDesktop.ps1') @launchArgs
        $desktop=Get-Content $launch -Raw | ConvertFrom-Json
        $exit=Get-Content ($launch+'.exit.json') -Raw | ConvertFrom-Json
        if ($desktop.sharedInputDesktopSwitched -or $desktop.securityMode -cne 'default-dacl-and-label' -or !$desktop.aclAndLabelBytesEqual) { throw 'Source-owned private desktop security admission failed.' }
        if ($exit.nativeExitCode -ne 0 -or !$exit.nativeHandleSignaled) { throw 'Admitted private native test process failed. Preserve its real leaf; do not blame the launcher or retry.' }
        if (!(Test-Path (Join-Path $out 'result.json'))) { throw 'Missing source-bound native stage receipt.' }
    }
    Json @{state='narrow-private-mounted-selections-passed-manual-pixel-review-required';foregroundProven=$false;keyboardProven=$false;compositorProven=$false;candidateTree=$pin.candidateTree;Before=@{cases=6;frames=16};After=@{cases=7;frames=16};Shared='RED-unwaived';fullBuild='not executed';wholeCampaign='not rerun';payloadSha256=$ExpectedPayloadSha256} (Join-Path $Artifacts 'result.json')
} catch {
    Json @{state='failed';leaf=$leaf;error=($_|Out-String);candidateTree=$pin.candidateTree;Shared='RED-unwaived';noRetry='The first Before picker selection bounds the unknown capture leaf.'} (Join-Path $Artifacts 'failure.json')
    throw
} finally {
    Json @(Get-ChildItem $Artifacts -Recurse -File | Where-Object {$_.Name -ne 'controller-artifact-hashes.json'} | ForEach-Object { @{path=[IO.Path]::GetRelativePath($Artifacts,$_.FullName);bytes=$_.Length;sha256=(Hash $_.FullName)} }) (Join-Path $Artifacts 'controller-artifact-hashes.json')
}
