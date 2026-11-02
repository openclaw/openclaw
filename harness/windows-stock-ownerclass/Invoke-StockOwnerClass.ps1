[CmdletBinding()]
param(
    [string]$Source = (Join-Path $env:GITHUB_WORKSPACE 'source-stock'),
    [string]$Artifacts = (Join-Path $env:GITHUB_WORKSPACE '.artifacts/stock-ownerclass')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
function Save-Json($Value,[string]$Path) { ConvertTo-Json -InputObject $Value -Depth 14 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Invoke-Git([string[]]$Arguments) {
    $value = & git -C $Source @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Pinned source Git query failed.' }
    $value
}
function Source-Snapshot {
    if ((Invoke-Git @('rev-parse','HEAD')).Trim() -cne $pin.sourceHead -or
        (Invoke-Git @('rev-parse','HEAD^{tree}')).Trim() -cne $pin.sourceTree) { throw 'Stock source head/tree mismatch.' }
    if (@(Invoke-Git @('status','--porcelain')).Count -ne 0) { throw 'Stock checkout must remain clean; no candidate or diagnostic overlay is allowed.' }
    $entries = @(Invoke-Git @('-c','core.quotepath=false','ls-tree','-r','--full-tree',$pin.sourceHead) | ForEach-Object {
        $tab = $_.IndexOf([char]9)
        if ($tab -lt 0) { throw 'Invalid tree entry.' }
        $meta = $_.Substring(0,$tab).Split(' ')
        if ($meta[1] -cne 'blob') { throw 'Unexpected non-blob source.' }
        @{path=$_.Substring($tab+1);blob=$meta[2]}
    })
    if ($entries.Count -ne $pin.sourceFileCount) { throw 'Stock tracked-source count changed.' }
    Push-Location $Source
    try {
        # Raw Git-blob hashes reject CRLF/filter substitutions without changing Git config.
        $actual = @($entries.path | & git hash-object --no-filters --stdin-paths)
        if ($LASTEXITCODE -ne 0 -or $actual.Count -ne $entries.Count) { throw 'Raw source hashing failed.' }
    } finally { Pop-Location }
    for ($i=0;$i -lt $entries.Count;$i++) {
        if ($actual[$i] -cne $entries[$i].blob) { throw "Noncanonical stock source bytes: $($entries[$i].path)" }
    }
    foreach ($file in $pin.sourceFilePins.PSObject.Properties) {
        if ((Hash (Join-Path $Source $file.Name)) -cne $file.Value) { throw "Relevant source pin mismatch: $($file.Name)" }
    }
    @($entries | ForEach-Object { @{path=$_.path;blob=$_.blob;sha256=(Hash (Join-Path $Source $_.path))} })
}
function Assert-Snapshot($Before) {
    $after = @(Source-Snapshot)
    if ($after.Count -ne $Before.Count) { throw 'Source inventory changed.' }
    for ($i=0;$i -lt $after.Count;$i++) {
        if ($after[$i].path -cne $Before[$i].path -or $after[$i].sha256 -cne $Before[$i].sha256) { throw 'Source changed during qualification.' }
    }
}
function Binary-Snapshot([string]$Directory) {
    @(Get-ChildItem -LiteralPath $Directory -Recurse -File | Sort-Object FullName | ForEach-Object {
        @{path=[IO.Path]::GetRelativePath($Directory,$_.FullName);bytes=$_.Length;sha256=(Hash $_.FullName)}
    })
}
function Assert-Binaries([string]$Directory,$Before) {
    $after = @(Binary-Snapshot $Directory)
    if ($after.Count -ne $Before.Count) { throw 'Binary inventory changed during test execution.' }
    for ($i=0;$i -lt $after.Count;$i++) {
        if ($after[$i].path -cne $Before[$i].path -or $after[$i].sha256 -cne $Before[$i].sha256) { throw 'Built test/dependency binaries changed during execution.' }
    }
}
function Run-Command([string]$Exe,[string[]]$Arguments,[string]$Name) {
    $native = $PSNativeCommandUseErrorActionPreference; $errorMode = $ErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false; $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $Artifacts "$Name.log") | Out-Host
        $code = $LASTEXITCODE
    } finally { $PSNativeCommandUseErrorActionPreference = $native; $ErrorActionPreference = $errorMode }
    @{name=$Name;executable=$Exe;arguments=$Arguments;exitCode=$code}
}
function Compare-Names([string[]]$Expected,[string[]]$Actual,[int]$PrefixLength) {
    $same = $Expected.Count -eq $Actual.Count
    $prefix = $Actual.Count -ge $PrefixLength -and $Expected.Count -ge $PrefixLength
    $first = $null
    for ($i=0;$i -lt [Math]::Max($Expected.Count,$Actual.Count);$i++) {
        if ($i -ge $Expected.Count -or $i -ge $Actual.Count -or $Expected[$i] -cne $Actual[$i]) {
            $same = $false
            if ($null -eq $first) { $first=$i+1 }
            if ($i -lt $PrefixLength) { $prefix=$false }
        }
    }
    @{fullOrderMatches=$same;prefixThroughOriginalFailureMatches=$prefix;firstDifferentOrdinal=$first}
}
function Read-DiagnosticTrx([string]$Path,[DateTime]$StartedUtc) {
    $file=Get-Item -LiteralPath $Path
    if ($file.LastWriteTimeUtc -lt $StartedUtc.ToUniversalTime().AddSeconds(-1)) { throw 'Stale diagnostic TRX.' }
    $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
    $reader=[Xml.XmlReader]::Create($file.FullName,$settings)
    try { $doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null;$doc.Load($reader) } finally { $reader.Dispose() }
    if ($doc.DocumentElement.LocalName -cne 'TestRun' -or $doc.DocumentElement.NamespaceURI -cne 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010') { throw 'Invalid diagnostic TRX root.' }
    $cases=@($doc.SelectNodes("//*[local-name()='UnitTestResult' and not(*[local-name()='InnerResults'])]"))
    if ($cases.Count -ne $pin.expectedCases -or @($cases | Where-Object { !$_.GetAttribute('testName').StartsWith('OpenClaw.Shared.Tests.ExecApprovalsStoreTests.',[StringComparison]::Ordinal) }).Count) { throw 'Selection was not exactly the original owner class.' }
    if (@($cases | ForEach-Object {$_.GetAttribute('executionId')} | Select-Object -Unique).Count -ne $cases.Count -or @($cases | Where-Object {$_.GetAttribute('executionId') -eq ''}).Count) { throw 'Duplicate/missing execution identity.' }
    $rows=@($cases | ForEach-Object {
        $start=[DateTimeOffset]::Parse($_.GetAttribute('startTime'));$end=[DateTimeOffset]::Parse($_.GetAttribute('endTime'))
        if ($end -lt $start -or $start.UtcDateTime -lt $StartedUtc.ToUniversalTime().AddSeconds(-1)) { throw 'Invalid/stale case timing.' }
        $message=$_.SelectSingleNode("./*[local-name()='Output']/*[local-name()='ErrorInfo']/*[local-name()='Message']")
        $stack=$_.SelectSingleNode("./*[local-name()='Output']/*[local-name()='ErrorInfo']/*[local-name()='StackTrace']")
        $errorText=if($null -ne $message){$message.InnerText}else{''}
        $match=[regex]::Match($errorText,'(?i)HResult\s*[:=]\s*(0x[0-9a-f]{8}|-?\d+)')
        @{testName=$_.GetAttribute('testName');outcome=$_.GetAttribute('outcome');executionId=$_.GetAttribute('executionId');startTime=$start.ToString('o');endTime=$end.ToString('o');duration=$_.GetAttribute('duration');message=$errorText;stack=if($null -ne $stack){$stack.InnerText}else{''};hResult=if($match.Success){$match.Groups[1].Value}else{$null}}
    } | Sort-Object @{Expression={[DateTimeOffset]::Parse($_.startTime)}},@{Expression={[DateTimeOffset]::Parse($_.endTime)}})
    if (@($rows | Where-Object {$_.outcome -cnotin @('Passed','Failed')}).Count) { throw 'Owner-class skips/other outcomes are not comparable.' }
    $counter=$doc.SelectSingleNode("//*[local-name()='ResultSummary']/*[local-name()='Counters']")
    if ($null -eq $counter) { throw 'Missing diagnostic counters.' }
    $passed=@($rows | Where-Object {$_.outcome -ceq 'Passed'}).Count;$failed=@($rows | Where-Object {$_.outcome -ceq 'Failed'}).Count
    if ([int]$counter.GetAttribute('total') -ne $pin.expectedCases -or [int]$counter.GetAttribute('executed') -ne $pin.expectedCases -or [int]$counter.GetAttribute('passed') -ne $passed -or [int]$counter.GetAttribute('failed') -ne $failed) { throw 'Diagnostic counters disagree with executed case rows.' }
    $unambiguous=$true
    for($i=1;$i -lt $rows.Count;$i++) {
        if([DateTimeOffset]::Parse($rows[$i].startTime) -le [DateTimeOffset]::Parse($rows[$i-1].startTime) -or
           [DateTimeOffset]::Parse($rows[$i].startTime) -lt [DateTimeOffset]::Parse($rows[$i-1].endTime)) {$unambiguous=$false}
    }
    $storage=@($doc.SelectNodes("//*[local-name()='UnitTest']") | ForEach-Object {$_.GetAttribute('storage')} | Select-Object -Unique)
    @{rows=$rows;passed=$passed;failed=$failed;executed=$rows.Count;assemblyStorage=$storage;chronologicalOrderUnambiguous=$unambiguous}
}
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or ![Environment]::Is64BitProcess) { throw 'Run only on the approved disposable x64 Windows2025 hosted CI route.' }
$Source=(Resolve-Path -LiteralPath $Source).Path;$Artifacts=[IO.Path]::GetFullPath($Artifacts)
if(Test-Path -LiteralPath $Artifacts){throw 'Fresh artifact destination required; no stale reports.'}
New-Item -ItemType Directory -Path $Artifacts | Out-Null
$exitCode=1;$repoRootBefore=[Environment]::GetEnvironmentVariable('OPENCLAW_REPO_ROOT')
Start-Transcript -Path (Join-Path $Artifacts 'qualification.log')
try {
    foreach($line in Get-Content (Join-Path $PSScriptRoot 'SHA256SUMS')) {
        if($line -notmatch '^([A-F0-9]{64})  ([A-Za-z0-9._-]+)$'){throw 'Invalid packet seal.'}
        if((Hash (Join-Path $PSScriptRoot $Matches[2])) -cne $Matches[1]){throw 'Packet input seal mismatch.'}
    }
    $pin=Get-Content (Join-Path $PSScriptRoot 'stock-inputs.json') -Raw | ConvertFrom-Json
    if((Hash (Join-Path $PSScriptRoot 'original-order.json')) -cne $pin.originalOrderSha256){throw 'Original-order seal mismatch.'}
    $original=Get-Content (Join-Path $PSScriptRoot 'original-order.json') -Raw | ConvertFrom-Json
    if($env:RUNNER_OS -cne 'Windows' -or $env:ImageOS -cne $pin.originalImageOS -or $env:GITHUB_RUN_ATTEMPT -cne '1'){throw 'Only one initial Windows2025 qualification attempt is allowed.'}
    if($original.order.Count -ne $pin.expectedCases){throw 'Original owner-class count mismatch.'}
    if($env:OPENCLAW_STATE_DIR -or $env:OPENCLAW_CI_COLLECT_COVERAGE -eq 'true'){throw 'Unexpected state override/coverage mode; refuse rather than clear or rewrite configuration.'}
    $sdk=(& dotnet --version).Trim();if($LASTEXITCODE -ne 0 -or $sdk -cne $pin.sdkVersion){throw 'Exact SDK10.0.403 required.'}
    & dotnet --info | Set-Content (Join-Path $Artifacts 'dotnet-info.txt') -Encoding utf8NoBOM
    & dotnet --list-runtimes | Set-Content (Join-Path $Artifacts 'dotnet-runtimes.txt') -Encoding utf8NoBOM
    $os=Get-CimInstance Win32_OperatingSystem
    Save-Json @{runId=$env:GITHUB_RUN_ID;runAttempt=$env:GITHUB_RUN_ATTEMPT;harnessSha=$env:GITHUB_SHA;imageOS=$env:ImageOS;imageVersion=$env:ImageVersion;osVersion=$os.Version;osBuild=$os.BuildNumber;processArchitecture=[Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString();sdk=$sdk;stateDirOverridePresent=[bool]$env:OPENCLAW_STATE_DIR;openClawHomeOverridePresent=[bool]$env:OPENCLAW_HOME;originalBclPatch='not recorded in original run';originalSharedGate='RED/unwaived'} (Join-Path $Artifacts 'run-metadata.json')
    $sourceFiles=@(Source-Snapshot);Save-Json $sourceFiles (Join-Path $Artifacts 'source-manifest.json')
    $env:OPENCLAW_REPO_ROOT=$Source
    Push-Location $Source
    try {
        $restore=Run-Command 'dotnet' @('restore',$pin.project) 'restore';Save-Json $restore (Join-Path $Artifacts 'restore.json');if($restore.exitCode -ne 0){throw 'Stock owner-class restore failed.'}
        $build=Run-Command 'dotnet' @('build',$pin.project,'-c','Debug','--no-restore') 'build';Save-Json $build (Join-Path $Artifacts 'build.json');if($build.exitCode -ne 0){throw 'Stock owner-class build failed.'}
        Assert-Snapshot $sourceFiles
        $testAssembly=Join-Path $Source $pin.testAssembly
        if(!(Test-Path -LiteralPath $testAssembly -PathType Leaf)){throw 'Expected built test assembly missing.'}
        $bin=Split-Path -Parent $testAssembly;$binaryFiles=@(Binary-Snapshot $bin)
        Save-Json $binaryFiles (Join-Path $Artifacts 'binary-manifest.json')
        $assets=Join-Path $Source 'tests/OpenClaw.Shared.Tests/obj/project.assets.json'
        Save-Json @{testAssembly=$testAssembly;testAssemblySha256=(Hash $testAssembly);sharedAssemblySha256=(Hash (Join-Path $bin 'OpenClaw.Shared.dll'));runtimeConfigSha256=(Hash (Join-Path $bin 'OpenClaw.Shared.Tests.runtimeconfig.json'));depsSha256=(Hash (Join-Path $bin 'OpenClaw.Shared.Tests.deps.json'));projectAssetsSha256=(Hash $assets);binding='source-owned runner --no-build, declared test container from console and TRX storage, pre/post full output manifest; no profiler or in-process probe'} (Join-Path $Artifacts 'build-binding.json')
        $testStart=[DateTime]::UtcNow
        # Source-owned execution/pass-admission owner. Default ordering, no worker/seed/timer options.
        $test=Run-Command 'pwsh' @('-NoProfile','-File',(Join-Path $Source 'scripts/Invoke-CiTest.ps1'),'-Project',$pin.project,'-ResultsDirectory',(Join-Path $Artifacts 'tests'),'-TrxFileName','owner-class-baseline.trx','-Filter',$pin.filter) 'test'
        Save-Json $test (Join-Path $Artifacts 'test-command.json')
        $reports=@(Get-ChildItem (Join-Path $Artifacts 'tests') -Filter 'owner-class-baseline.trx' -File -Recurse)
        if($reports.Count -ne 1){throw 'Exactly one fresh owner-class TRX required.'}
        # Failure parsing is diagnostic only. It never bypasses the canonical pass contract.
        $data=Read-DiagnosticTrx $reports[0].FullName $testStart
        Save-Json $data.rows (Join-Path $Artifacts 'actual-order-and-outcomes.json')
        $actualNames=@($data.rows | ForEach-Object {$_.testName});$expectedNames=@($original.order | ForEach-Object {$_.testName})
        if((($actualNames | Sort-Object -CaseSensitive) -join ([string][char]10)) -cne (($expectedNames | Sort-Object -CaseSensitive) -join ([string][char]10))){throw 'Owner-class case identities differ.'}
        $order=Compare-Names $expectedNames $actualNames $original.originalFailureOrdinal
        $order.chronologicalOrderUnambiguous=$data.chronologicalOrderUnambiguous
        $log=[IO.File]::ReadAllText((Join-Path $Artifacts 'test.log'))
        $containers=@([regex]::Matches($log,'Test run for ([^\r\n]+?\.dll) \('))
        if($containers.Count -ne 1 -or ![string]::Equals([IO.Path]::GetFullPath($containers[0].Groups[1].Value),[IO.Path]::GetFullPath($testAssembly),[StringComparison]::OrdinalIgnoreCase)){throw 'Executed test-container path is not the sealed built assembly.'}
        if($data.assemblyStorage.Count -ne 1){throw 'Exactly one declared TRX assembly storage path required.'}
        if(@($data.assemblyStorage | Where-Object {![string]::Equals([IO.Path]::GetFullPath($_),[IO.Path]::GetFullPath($testAssembly),[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'TRX storage differs from built test container.'}
        Assert-Binaries $bin $binaryFiles;Assert-Snapshot $sourceFiles
        $canonicalPass=$false
        if($test.exitCode -eq 0){
            . (Join-Path $Source 'scripts/TestResultContract.ps1')
            [void](Read-TestResultContract -Path $reports[0].FullName -StartedUtc $testStart -ExitCode 0)
            $canonicalPass=$true
        } elseif($data.failed -eq 0){throw 'Nonzero test command exit without failed cases is not valid qualification.'}
        $failures=@($data.rows | Where-Object {$_.outcome -ceq 'Failed'})
        $sameFailure=@($failures | Where-Object {$_.testName -ceq $original.originalFailure -and $_.message.Contains('UnauthorizedAccessException') -and $_.stack.Contains('WriteAtomically') -and $_.stack.Contains('1823')}).Count -gt 0
        $status=if(!$order.fullOrderMatches -or !$order.chronologicalOrderUnambiguous){'NONCOMPARABLE_ORDER'}elseif($canonicalPass){'NONREPRODUCTION_ONLY'}elseif($sameFailure){'STOCK_CLASS_FAILURE_OBSERVED'}else{'DIFFERENT_STOCK_CLASS_FAILURE'}
        Save-Json @{status=$status;sourceHead=$pin.sourceHead;sourceTree=$pin.sourceTree;sdk=$sdk;executed=$data.executed;passed=$data.passed;failed=$data.failed;skipped=0;order=$order;testExitCode=$test.exitCode;canonicalPassContract=$canonicalPass;sameFailureSignature=$sameFailure;failures=$failures;originalSharedGate='RED/unwaived';fixClaim=$false;comparabilityLimits=@('class-only selection omits original cross-class interleaving and preceding native/full-build workload','exact original loaded BCL/Shared binary identities were not retained','stock build metadata or host load may differ; no order/seed/config changes are applied','pre/post manifest plus declared test-container/deps binding is not an in-process module trace','failed HResult is null unless present in unmodified test output; actual blocking handle remains unproven')} (Join-Path $Artifacts 'result.json')
        if($status -ceq 'NONREPRODUCTION_ONLY'){$exitCode=0}
    } finally { Pop-Location }
} catch {
    Save-Json @{status='INPUT_OR_EXECUTION_FAILURE';error=($_ | Out-String);originalSharedGate='RED/unwaived';fixClaim=$false} (Join-Path $Artifacts 'failure.json')
} finally {
    [Environment]::SetEnvironmentVariable('OPENCLAW_REPO_ROOT',$repoRootBefore)
    Stop-Transcript
    $hashes=@(Get-ChildItem $Artifacts -Recurse -File | Sort-Object FullName | ForEach-Object {@{path=[IO.Path]::GetRelativePath($Artifacts,$_.FullName);bytes=$_.Length;sha256=(Hash $_.FullName)}})
    Save-Json $hashes (Join-Path $Artifacts 'artifact-hashes.json')
}
exit $exitCode
