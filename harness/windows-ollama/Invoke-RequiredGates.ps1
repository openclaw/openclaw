[CmdletBinding()]
param([Parameter(Mandatory)][string]$BeforeSource,[Parameter(Mandatory)][string]$AfterSource,[Parameter(Mandatory)][string]$Artifacts)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
Assert-Packet
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable authorized native CI only.' }
Assert-Product $AfterSource -WithComparison
$overlayPath = Join-Path $AfterSource 'tests/OpenClaw.Tray.UITests/NativeOllamaOsInspectionTests.cs'
if (Test-Path $overlayPath) { throw 'Refuse preexisting OS inspection overlay.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'NativeOllamaOsInspectionTests.cs') -Destination $overlayPath
Assert-Product $AfterSource -WithComparison
$env:GitVersion_NoNormalizeEnabled = 'true'
$env:GitVersion_NoFetchEnabled = 'true'
$env:OPENCLAW_REPO_ROOT = $AfterSource
$env:OPENCLAW_TRAY_DATA_DIR = Join-Path $env:RUNNER_TEMP 'ollama-gates-data'
$env:OPENCLAW_TRAY_APPDATA_DIR = Join-Path $env:RUNNER_TEMP 'ollama-gates-roaming'
$env:OPENCLAW_TRAY_LOCALAPPDATA_DIR = Join-Path $env:RUNNER_TEMP 'ollama-gates-local'
$env:OPENCLAW_RUN_INTEGRATION = '1'
$env:OPENCLAW_CI_COLLECT_COVERAGE = 'false'
$script:gates = @()
function Gate([string]$Name,[scriptblock]$Body) {
    $started = [datetime]::UtcNow
    try {
        & $Body
        $script:gates += @{name=$Name;status='passed';startedUtc=$started;finishedUtc=[datetime]::UtcNow}
    } catch {
        $script:gates += @{name=$Name;status='failed';startedUtc=$started;finishedUtc=[datetime]::UtcNow;failure=($_ | Out-String)}
        Write-Warning "Required stage failed: $Name. Retaining evidence and attempting independent stages."
    }
    Save-Json $script:gates (Join-Path $Artifacts 'required-gates.json')
}
Start-Transcript -Path (Join-Path $Artifacts 'required-gates.log')
$sourceFiles = @(Source-Manifest $AfterSource)
Save-Json $sourceFiles (Join-Path $Artifacts 'pre-build-source.json')
Push-Location $AfterSource
try {
    Gate 'full-build' {
        & (Join-Path $AfterSource 'build.ps1') -Project All -Configuration Debug -NoTrustRepository
        if ($LASTEXITCODE -ne 0) { throw 'Required full build failed.' }
    }
    Gate 'canonical-native-docs' {
        & (Join-Path $AfterSource 'scripts/validate-docs.ps1') -RepoRoot $AfterSource
        if (!$?) { throw 'Canonical native documentation validation failed.' }
    }
    foreach ($entry in @(
        @{name='Shared';runtime=''}, @{name='Connection';runtime=''},
        @{name='Tray';runtime='win-x64'}, @{name='SetupEngine';runtime='win-x64'})) {
        $project = "tests/OpenClaw.$($entry.name).Tests"
        $build = @('build',$project,'-c','Debug')
        if ($entry.runtime) { $build += @('-r',$entry.runtime) }
        Gate "$($entry.name)-build" { Invoke-Checked 'dotnet' $build }
        if ($script:gates[-1].status -ceq 'passed') {
            Gate "$($entry.name)-full-tests" {
                $testArgs = @{Project=$project;ResultsDirectory=(Join-Path $Artifacts "ordinary-$($entry.name)")
                    TrxFileName="$($entry.name).trx";HangTimeoutSeconds=300}
                if ($entry.runtime) { $testArgs.Runtime = $entry.runtime }
                & (Join-Path $AfterSource 'scripts/Invoke-CiTest.ps1') @testArgs
                if ($LASTEXITCODE -ne 0) { throw 'Ordinary test invocation failed.' }
                $reports = @(Get-ChildItem -LiteralPath (Join-Path $Artifacts "ordinary-$($entry.name)") -Filter '*.trx' -Recurse -File)
                if ($reports.Count -ne 1) { throw 'Ordinary test report inventory differs.' }
                [xml]$trx = Get-Content -LiteralPath $reports[0].FullName -Raw
                $counter = $trx.SelectSingleNode("//*[local-name()='Counters']")
                Save-Json @{qualification='ordinary CI, supported environment skips reported separately; not custom/native proof';total=[int]$counter.total;executed=[int]$counter.executed;passed=[int]$counter.passed;failed=[int]$counter.failed;notExecuted=[int]$counter.notExecuted} ($reports[0].FullName + '.ordinary.json')
            }
        }
    }
    Gate 'strict-ollama-owner-and-admitted-runner-17-cases' {
        . (Join-Path $AfterSource 'scripts/TestResultContract.ps1')
        $invocation = New-TestInvocation -ResultsDirectory (Join-Path $Artifacts 'strict-owners') -TrxFileName 'ollama-owner.trx'
        $filter = 'FullyQualifiedName~OllamaWindowsSetupTests|FullyQualifiedName~CommandRunnerTests.AdmittedInstaller_'
        Invoke-Checked 'dotnet' @('test','tests/OpenClaw.SetupEngine.Tests','--no-build','--no-restore','-c','Debug','-r','win-x64',
            '--filter',$filter,'--results-directory',$invocation.directory,'--logger','trx;LogFileName=ollama-owner.trx',
            '--blame-hang','--blame-hang-timeout','180s','--blame-hang-dump-type','none')
        Assert-StrictTrx $invocation.report 17 $invocation.startedUtc
    }
    foreach ($stage in @('After','Before')) {
        $source = if ($stage -ceq 'After') { $AfterSource } else { $BeforeSource }
        Gate "$stage-UI-build" {
            Invoke-Checked 'dotnet' @('build',(Join-Path $source 'tests/OpenClaw.Tray.UITests/OpenClaw.Tray.UITests.csproj'),'-c','Debug','-r','win-x64')
        }
        if ($script:gates[-1].status -ceq 'passed') {
            Gate "$stage-private-native-UI" {
                # This wrapper's bounded tree cleanup is suitable ONLY for synthetic test processes
                # and real read-only OS inspection. Never put an admitted external installer below it.
                $driver = Join-Path $PSScriptRoot 'Invoke-UiStage.ps1'
                $line = '-NoProfile -NonInteractive -File "' + $driver + '" -Source "' + $source + '" -Stage ' + $stage + ' -Artifacts "' + $Artifacts + '"'
                $launch = Join-Path $Artifacts "$stage-private-desktop.json"
                $launchArgs = @{
                    Executable=(Join-Path $PSHOME 'pwsh.exe'); ArgumentLine=$line
                    DataDirectory=(Join-Path $env:RUNNER_TEMP "ollama-$stage-private-data")
                    McpPort=18789; ConsoleProcess=$true; WaitForExit=$true
                    ProcessTimeoutSeconds=900; NamePrefix="Ollama$stage"; ResultPath=$launch
                }
                & (Join-Path $source 'scripts/Invoke-PrivateDesktop.ps1') @launchArgs
                $exit = Get-Content -LiteralPath ($launch + '.exit.json') -Raw | ConvertFrom-Json
                $desktop = Get-Content -LiteralPath $launch -Raw | ConvertFrom-Json
                if ($exit.nativeExitCode -ne 0 -or !$exit.nativeHandleSignaled -or $desktop.sharedInputDesktopSwitched -or
                    $desktop.securityMode -cne 'default-dacl-and-label' -or !$desktop.aclAndLabelBytesEqual) { throw 'Private desktop execution or guard admission failed.' }
                if (!(Test-Path (Join-Path $Artifacts "$stage/result.json"))) { throw 'Missing strict UI result.' }
            }
        }
    }
    Gate 'source-postflight' {
        Assert-Product $AfterSource -WithComparison
        Assert-Files $AfterSource $sourceFiles
        if (@(Compare-Object ($sourceFiles.path | Sort-Object) (@(Source-Manifest $AfterSource).path | Sort-Object)).Count -ne 0) { throw 'Source inventory changed during required gates.' }
    }
} finally {
    Pop-Location
    Stop-Transcript
}
Save-Json @{qualification='Required build/test/fixture stages only; no installed-app acceptance';gates=$script:gates;failed=@($script:gates | Where-Object {$_.status -cne 'passed'}).Count} (Join-Path $Artifacts 'required-summary.json')
if (@($script:gates | Where-Object {$_.status -cne 'passed'}).Count -ne 0) { throw 'One or more required build/test stages failed. See required-gates.json.' }
