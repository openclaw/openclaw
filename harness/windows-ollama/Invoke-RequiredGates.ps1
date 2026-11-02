[CmdletBinding()]
param([Parameter(Mandatory)][string]$BeforeSource,[Parameter(Mandatory)][string]$AfterSource,[Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
$BeforeSource = Resolve-ExistingDirectory $BeforeSource
$AfterSource = Resolve-ExistingDirectory $AfterSource
$Artifacts = Resolve-ExistingDirectory $Artifacts
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') { throw 'Disposable authorized Windows CI only.' }
Assert-Product $AfterSource -WithComparison
$env:GitVersion_NoNormalizeEnabled='true';$env:GitVersion_NoFetchEnabled='true'
$env:OPENCLAW_REPO_ROOT=$AfterSource
$env:OPENCLAW_TRAY_DATA_DIR=Join-Path $env:RUNNER_TEMP 'ollama-repair-data'
$env:OPENCLAW_TRAY_APPDATA_DIR=Join-Path $env:RUNNER_TEMP 'ollama-repair-roaming'
$env:OPENCLAW_TRAY_LOCALAPPDATA_DIR=Join-Path $env:RUNNER_TEMP 'ollama-repair-local'
$env:OPENCLAW_RUN_INTEGRATION='1';$env:OPENCLAW_CI_COLLECT_COVERAGE='false'
$script:gates=@()
function Gate([string]$Name,[scriptblock]$Body) {
    $started=[datetime]::UtcNow
    try { & $Body; $script:gates+=@{name=$Name;status='passed';startedUtc=$started;finishedUtc=[datetime]::UtcNow} }
    catch { $script:gates+=@{name=$Name;status='failed';startedUtc=$started;finishedUtc=[datetime]::UtcNow;failure=($_|Out-String)};Write-Warning "Required repair stage failed: $Name" }
    Save-Json $script:gates (Join-Path $Artifacts 'required-gates.json')
}
Start-Transcript -Path (Join-Path $Artifacts 'required-gates.log')
$sourceFiles=@(Source-Manifest $AfterSource)
Save-Json $sourceFiles (Join-Path $Artifacts 'pre-build-source.json')
Push-Location $AfterSource
try {
    Gate 'retained-proof-admission' {
        $retained=Get-Content (Join-Path $PSScriptRoot 'RETAINED-EVIDENCE.json') -Raw|ConvertFrom-Json
        if ($retained.runId -ne 41495507649 -or $retained.artifactZipSha256 -cne '77342554bfd0e130a61d36d559134c054222c2da4e7f6187a35aa0c3062b5218') { throw 'Prior evidence identity differs.' }
        foreach ($group in $retained.closure.PSObject.Properties) {
            foreach ($file in $group.Value.PSObject.Properties) {
                if ((Hash (Join-Path $AfterSource $file.Name)) -cne $file.Value) { throw "Reused owner input changed: $($file.Name)" }
            }
        }
        $strict=$retained.passedSuites.PSObject.Properties['strict-owners'].Value
        if ($strict.passed -ne 17 -or $strict.failed -ne 0 -or $strict.skipped -ne 0 -or $strict.rows.Count -ne 17 -or
            @($strict.rows|Where-Object {$_.outcome -cne 'Passed'}).Count -ne 0) { throw 'The retained17-case receipt does not qualify.' }
        Save-Json @{qualification='Actual prior native proof, NOT current execution. Independent passing scopes retained after source-closure verification.';
            runId=$retained.runId;passedSuites=$retained.passedSuites;docs=$retained.docs;priorFailedSuites=$retained.priorFailedSuites;
            sourceRootChange='Canonical filesystem spelling repairs the harness producer. Prior environment is retained as historical evidence, not represented as an exact replay.'} (Join-Path $Artifacts 'retained-evidence.json')
    }
    Gate 'full-build' {
        $prior=[Environment]::GetEnvironmentVariable('WriteVersionInfoToBuildLog','Process')
        try {
            [Environment]::SetEnvironmentVariable('WriteVersionInfoToBuildLog','false','Process')
            # Canonical child scope, retaining All/Debug/NoTrust. Caller StrictMode stays intact.
            Invoke-Checked (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-File',(Join-Path $AfterSource 'build.ps1'),'-Project','All','-Configuration','Debug','-NoTrustRepository')
        } finally { [Environment]::SetEnvironmentVariable('WriteVersionInfoToBuildLog',$prior,'Process') }
    }
    Gate 'Shared-build' { Invoke-Checked 'dotnet' @('build','tests/OpenClaw.Shared.Tests','-c','Debug','-p:WriteVersionInfoToBuildLog=false') }
    if ($script:gates[-1].status -ceq 'passed') {
        Gate 'Shared-full-tests' {
            # The suite failed44 root-sensitive cases and the shared root producer changed.
            & (Join-Path $AfterSource 'scripts/Invoke-CiTest.ps1') -Project tests/OpenClaw.Shared.Tests -ResultsDirectory (Join-Path $Artifacts 'ordinary-Shared') -TrxFileName Shared.trx -HangTimeoutSeconds 300
            if ($LASTEXITCODE -ne 0) { throw 'Root-sensitive Shared suite did not qualify.' }
        }
    }
    Gate 'SetupEngine-build' { Invoke-Checked 'dotnet' @('build','tests/OpenClaw.SetupEngine.Tests','-c','Debug','-r','win-x64','-p:WriteVersionInfoToBuildLog=false') }
    if ($script:gates[-1].status -ceq 'passed') {
        Gate 'SetupEngine-artwork-owner-repair-3-cases' {
            . (Join-Path $AfterSource 'scripts/TestResultContract.ps1')
            $invocation=New-TestInvocation -ResultsDirectory (Join-Path $Artifacts 'artwork-owner-repair') -TrxFileName artwork-owner.trx
            Invoke-Checked 'dotnet' @('test','tests/OpenClaw.SetupEngine.Tests','--no-build','--no-restore','-c','Debug','-r','win-x64',
                '--filter','FullyQualifiedName~ProviderArtworkSourceContractTests','--results-directory',$invocation.directory,'--logger','trx;LogFileName=artwork-owner.trx')
            Assert-StrictTrx $invocation.report 3 $invocation.startedUtc
        }
    }
    foreach ($stage in @('After','Before')) {
        $source=if($stage -ceq 'After'){$AfterSource}else{$BeforeSource}
        Gate "$stage-UI-build" {
            Invoke-Checked 'dotnet' @('build',(Join-Path $source 'tests/OpenClaw.Tray.UITests/OpenClaw.Tray.UITests.csproj'),'-c','Debug','-r','win-x64','-p:WriteVersionInfoToBuildLog=false')
            & (Join-Path $PSScriptRoot 'Save-CalculatedVersion.ps1') -Source $source -Artifacts $Artifacts -Stage $stage
        }
        if ($script:gates[-1].status -ceq 'passed') {
            Gate "$stage-private-native-UI" {
                $driver=Join-Path $PSScriptRoot 'Invoke-UiStage.ps1'
                $line='-NoProfile -NonInteractive -File "'+$driver+'" -Source "'+$source+'" -Stage '+$stage+' -Artifacts "'+$Artifacts+'"'
                $launch=Join-Path $Artifacts "$stage-private-desktop.json"
                $launchArgs=@{Executable=(Join-Path $PSHOME 'pwsh.exe');ArgumentLine=$line;
                    DataDirectory=(Join-Path $env:RUNNER_TEMP "ollama-$stage-private-data");McpPort=18789;ConsoleProcess=$true;WaitForExit=$true;
                    ProcessTimeoutSeconds=900;NamePrefix="Ollama$stage";ResultPath=$launch}
                & (Join-Path $source 'scripts/Invoke-PrivateDesktop.ps1') @launchArgs
                $exit=Get-Content ($launch+'.exit.json') -Raw|ConvertFrom-Json
                $desktop=Get-Content $launch -Raw|ConvertFrom-Json
                if ($desktop.sharedInputDesktopSwitched -or $desktop.securityMode -cne 'default-dacl-and-label' -or !$desktop.aclAndLabelBytesEqual) { throw 'Private desktop security admission failed.' }
                if ($exit.nativeExitCode -ne 0 -or !$exit.nativeHandleSignaled) { throw 'Admitted private fixture failed; inspect its actual test/presentation failure. Security admission is not blamed.' }
                if (!(Test-Path (Join-Path $Artifacts "$stage/result.json"))) { throw 'Missing required private fixture result.' }
            }
        }
    }
    Gate 'source-postflight' {
        Assert-Product $AfterSource -WithComparison
        Assert-Files $AfterSource $sourceFiles
        if (@(Compare-Object ($sourceFiles.path|Sort-Object) (@(Source-Manifest $AfterSource).path|Sort-Object)).Count -ne 0) { throw 'Source inventory changed during repair gates.' }
    }
} finally { Pop-Location;Stop-Transcript }
Save-Json @{qualification='Scoped repair execution plus explicitly retained prior evidence. Not a fresh rerun of all previous suites.';
    gates=$script:gates;failed=@($script:gates|Where-Object {$_.status -cne 'passed'}).Count;
    originalStrict31=@{reusedPrior17=17;requiredBefore=2;requiredAfter=12};freshAdditionalArtworkCases=3;
    setupFullSuite='Prior single failing owner is repaired separately; previous full failure remains recorded, not relabeled a fresh full-suite pass.'} (Join-Path $Artifacts 'required-summary.json')
if (@($script:gates|Where-Object {$_.status -cne 'passed'}).Count -ne 0) { throw 'One or more required repair gates failed.' }
