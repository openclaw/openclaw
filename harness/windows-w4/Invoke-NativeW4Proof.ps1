[CmdletBinding()]
param(
    [string]$AfterSource = (Join-Path $env:GITHUB_WORKSPACE 'source-after'),
    [string]$Artifacts = (Join-Path $env:GITHUB_WORKSPACE '.artifacts/native-w4/windows')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
function Save-Json($Value, [string]$Path) {
    ConvertTo-Json -InputObject $Value -Depth 12 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Invoke-Git([string]$Source, [string[]]$Arguments) {
    $result = & git -C $Source @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Git source query failed: $Source" }
    $result
}
function Assert-Source([string]$Source, $Pin) {
    if ((Invoke-Git $Source @('rev-parse','HEAD')).Trim() -cne $Pin.head) { throw 'Pinned source HEAD mismatch.' }
    if (@(Invoke-Git $Source @('status','--porcelain')).Count -ne 0) { throw 'Proof requires a fresh clean source checkout.' }
    foreach ($file in $Pin.files.PSObject.Properties) {
        if ((Hash (Join-Path $Source $file.Name)) -cne $file.Value) { throw "Source pin mismatch: $($file.Name)" }
    }
}
function Source-Manifest([string]$Source) {
    @(Invoke-Git $Source @('-c','core.quotepath=false','ls-files','--cached','--others','--exclude-standard') |
        Sort-Object -Unique | ForEach-Object { @{path=$_; sha256=(Hash (Join-Path $Source $_))} })
}
function Assert-Files([string]$Base, $Entries, [string]$Prefix = '') {
    foreach ($entry in $Entries) {
        $relative = if ($Prefix) { $entry.path.Substring($Prefix.Length) } else { $entry.path }
        if ((Hash (Join-Path $Base $relative)) -cne $entry.sha256) { throw "Frozen file changed: $relative" }
    }
}
function Assert-CandidateSource([string]$Source) {
    if ((Invoke-Git $Source @('rev-parse','HEAD')).Trim() -cne $candidate.head) { throw 'Candidate base HEAD changed.' }
    foreach ($file in $candidate.files.PSObject.Properties) {
        if ((Hash (Join-Path $Source $file.Name)) -cne $file.Value) { throw "Candidate source hash mismatch: $($file.Name)" }
    }
    $actual = @(Invoke-Git $Source @('diff','--name-only') | Sort-Object)
    $expected = @($candidate.changedPaths | Sort-Object)
    if (($actual -join ([string][char]10)) -cne ($expected -join ([string][char]10))) { throw 'Candidate changed-path set differs from reviewed patch.' }
    if (@(Invoke-Git $Source @('diff','--cached','--name-only')).Count -ne 0 -or
        @(Invoke-Git $Source @('ls-files','--others','--exclude-standard')).Count -ne 0) { throw 'Candidate index or untracked source differs.' }
}
function Invoke-CloseoutCommand([string]$Executable, [string[]]$Arguments, [string]$Name, [string]$Out) {
    $previousNative = $PSNativeCommandUseErrorActionPreference
    $previousError = $ErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    $ErrorActionPreference = 'Continue'
    try {
        & $Executable @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $Out "$Name.log") | Out-Host
        $exit = $LASTEXITCODE
    } finally { $PSNativeCommandUseErrorActionPreference = $previousNative; $ErrorActionPreference = $previousError }
    @{name=$Name;command=(@($Executable)+$Arguments)-join ' ';exitCode=$exit}
}
function Run-Closeout([string]$Source) {
    $out = Join-Path $Artifacts 'closeout'
    New-Item -ItemType Directory -Path $out | Out-Null
    $records = [Collections.Generic.List[object]]::new()
    Push-Location $Source
    try {
        $env:OPENCLAW_REPO_ROOT = $Source
        $env:OPENCLAW_TRAY_DATA_DIR = Join-Path $env:RUNNER_TEMP 'w4-closeout-data'
        $env:OPENCLAW_TRAY_APPDATA_DIR = Join-Path $env:RUNNER_TEMP 'w4-closeout-roaming'
        $env:OPENCLAW_TRAY_LOCALAPPDATA_DIR = Join-Path $env:RUNNER_TEMP 'w4-closeout-local'
        # A child pwsh preserves this driver's failure receipt even when build.ps1 exits.
        $records.Add((Invoke-CloseoutCommand 'pwsh' @('-NoProfile','-File','./build.ps1') 'full-build' $out))
        foreach ($suite in @('Shared','Tray')) {
            $project = "./tests/OpenClaw.$suite.Tests/OpenClaw.$suite.Tests.csproj"
            $records.Add((Invoke-CloseoutCommand 'dotnet' @('restore',$project) "$suite-restore" $out))
            $records.Add((Invoke-CloseoutCommand 'dotnet' @('build',$project,'--no-restore') "$suite-build" $out))
            $record = Invoke-CloseoutCommand 'dotnet' @('test',$project,'--no-restore','--results-directory',$out,'--logger',"trx;LogFileName=$suite.trx") "$suite-test" $out
            $valid = $false
            $report = Join-Path $out "$suite.trx"
            if (Test-Path $report) {
                [xml]$trx = Get-Content $report -Raw
                $counters = $trx.SelectSingleNode("//*[local-name()='Counters']")
                if ($null -ne $counters) {
                    $record.executed = [int]$counters.executed
                    $record.passed = [int]$counters.passed
                    $record.failed = [int]$counters.failed
                    $record.notExecuted = [int]$counters.notExecuted
                    $valid = $record.executed -gt 0 -and $record.failed -eq 0 -and $record.passed -eq $record.executed
                }
            }
            $record.nonzeroExecutionVerified = $valid
            $records.Add($record)
        }
        Save-Json @($records.ToArray()) (Join-Path $out 'closeout.json')
        if (@($records | Where-Object {$_.exitCode -ne 0 -or $_.ContainsKey('nonzeroExecutionVerified') -and !$_.nonzeroExecutionVerified}).Count -ne 0) {
            throw 'Required full build/Shared/Tray closeout failed or ran zero tests. Preserve every result; do not waive.'
        }
    } finally { Pop-Location }
}
function Run-Stage([string]$Source, [string]$Stage, $Pin) {
    $out = Join-Path $Artifacts $Stage
    $freeze = Join-Path $Artifacts "freeze-$Stage"
    New-Item -ItemType Directory -Path $out,$freeze -Force | Out-Null
    Assert-CandidateSource $Source
    $testPath = Join-Path $Source 'tests/OpenClaw.Tray.UITests/OnboardingAiPageTests.cs'
    $marker = '    private bool _nativeProof;'
    $text = [IO.File]::ReadAllText($testPath)
    if ([regex]::Matches($text, [regex]::Escape($marker)).Count -ne 1) { throw 'Comparison test insertion anchor is not unique.' }
    $overlay = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'comparison-method.txt'))
    if ($overlay.Contains([string][char]13)) { throw 'Overlay must use canonical LF bytes.' }
    [IO.File]::WriteAllText($testPath, $text.Replace($marker, $marker + ([string][char]10) + $overlay), [Text.UTF8Encoding]::new($false))
    Invoke-Git $Source @('diff','--check')
    $changed = @(Invoke-Git $Source @('diff','--name-only'))
    if ((($changed | Sort-Object) -join ([string][char]10)) -cne (($candidate.changedPaths | Sort-Object) -join ([string][char]10))) { throw 'Overlay changed paths outside the sealed candidate.' }
    Invoke-Git $Source @('diff','--binary') | Set-Content (Join-Path $out 'capture-overlay.patch') -Encoding utf8NoBOM
    Push-Location $Source
    try {
        $env:OPENCLAW_REPO_ROOT = $Source
        $env:GitVersion_NoNormalizeEnabled = 'true'
        $env:GitVersion_NoFetchEnabled = 'true'
        $project = 'tests/OpenClaw.Tray.UITests/OpenClaw.Tray.UITests.csproj'
        # The proven native UI lane is an ordinary x64 build, never publish or DevBuild.
        & dotnet restore $project -r win-x64
        & dotnet build $project -c Debug -r win-x64 --no-restore
        if ((Invoke-Git $Source @('rev-parse','HEAD')).Trim() -cne $Pin.head) { throw 'Build changed the source revision.' }
        $files = @(Source-Manifest $Source)
        Save-Json $files (Join-Path $freeze 'full-source-manifest.json')
        $bin = Join-Path $Source 'tests/OpenClaw.Tray.UITests/bin/Debug/net10.0-windows10.0.22621.0/win-x64'
        $binaries = @(Get-ChildItem -LiteralPath $bin -File | Sort-Object Name | ForEach-Object {
            @{path="build\ui-tests\$($_.Name)";sha256=(Hash $_.FullName)}
        })
        if ($binaries.Count -eq 0) { throw 'Build produced no test binaries.' }
        Save-Json $binaries (Join-Path $freeze 'build-manifest.json')
        Save-Json @{head=$Pin.head;fullSourceManifestSha=(Hash (Join-Path $freeze 'full-source-manifest.json'));buildManifestSha=(Hash (Join-Path $freeze 'build-manifest.json'))} (Join-Path $freeze 'manifest.json')
        $env:OPENCLAW_TRAY_DATA_DIR = Join-Path $env:RUNNER_TEMP "llama-$Stage-data"
        $env:OPENCLAW_TRAY_APPDATA_DIR = Join-Path $env:RUNNER_TEMP "llama-$Stage-roaming"
        $env:OPENCLAW_TRAY_LOCALAPPDATA_DIR = Join-Path $env:RUNNER_TEMP "llama-$Stage-local"
        $env:OPENCLAW_UI_PROOF_DIR = $out
        $env:OPENCLAW_UI_PROOF_FREEZE_DIR = $freeze
        $env:OPENCLAW_UI_PROOF_MANIFEST_SHA256 = Hash (Join-Path $freeze 'manifest.json')
        $filter = 'FullyQualifiedName~OnboardingAiPageTests.W4Packet_|FullyQualifiedName~OnboardingAiPageTests.LlamaApp_EmptyFallbackAppearsOnlyWithoutAUsefulLocalHandoff|FullyQualifiedName~OnboardingAiPageTests.LocalPrepareRows_HonorAdvertisedActionAndDispatchPreparation'
        $expectedCases = 15
        $expectedFrames = @('w4-manual-collapsed-Light','w4-manual-collapsed-Dark','w4-manual-expanded-Light','w4-auth-control-Light','w4-prepare-llama-app-Light','w4-prepare-ollama-Light','w4-llamacpp-identity-Light')
        & dotnet test $project --no-build --no-restore -c Debug -r win-x64 --filter $filter --results-directory $out --logger "trx;LogFileName=$Stage.trx" --blame-hang --blame-hang-timeout 120s --blame-hang-dump-type none
        [xml]$trx = Get-Content -LiteralPath (Join-Path $out "$Stage.trx") -Raw
        $cases = @($trx.SelectNodes("//*[local-name()='UnitTestResult']"))
        $counters = $trx.SelectSingleNode("//*[local-name()='Counters']")
        if ($cases.Count -ne $expectedCases -or @($cases | Where-Object {$_.outcome -cne 'Passed'}).Count -ne 0 -or [int]$counters.executed -ne $expectedCases -or [int]$counters.passed -ne $expectedCases) { throw "$Stage selected cases did not all execute and pass." }
        $images = @(Get-ChildItem -LiteralPath $out -Filter '*.png' -File)
        if ($images.Count -ne $expectedFrames.Count) { throw "$Stage produced an unexpected screenshot count." }
        foreach ($name in $expectedFrames) {
            $image = Join-Path $out "$name.png"
            $metadata = Get-Content -LiteralPath (Join-Path $out "$name.json") -Raw | ConvertFrom-Json
            if ((Hash $image) -cne $metadata.sha256 -or $metadata.head -cne $Pin.head -or $metadata.method -cne 'PrintWindow(PW_RENDERFULLCONTENT), no fallback') { throw "Invalid native frame identity: $name" }
        }
        $baseline = Get-Content (Join-Path $PSScriptRoot 'baseline-reference.json') -Raw | ConvertFrom-Json
        foreach ($theme in @('Light','Dark')) {
            $frame = Get-Content (Join-Path $out "w4-manual-collapsed-$theme.json") -Raw | ConvertFrom-Json
            $prior = $baseline.frames.$theme
            if ($frame.dpi -ne $prior.dpi -or $frame.rasterizationScale -ne $prior.rasterizationScale -or
                $frame.xamlRootSize.Width -ne $prior.width -or $frame.xamlRootSize.Height -ne $prior.height) { throw 'Before/After geometry or DPI does not match retained baseline.' }
        }
        Assert-Files $Source $files
        Assert-Files $bin $binaries 'build\ui-tests\'
        if (@(Source-Manifest $Source).Count -ne $files.Count) { throw 'Frozen source inventory changed.' }
        if ((Invoke-Git $Source @('rev-parse','HEAD')).Trim() -cne $Pin.head) { throw 'Test changed source HEAD.' }
        Save-Json @{stage=$Stage;head=$Pin.head;dirtyCandidatePatchSha256=$candidate.patchSha256;executed=$cases.Count;passed=$cases.Count;skipped=0;frames=$expectedFrames;freezeManifestSha256=$env:OPENCLAW_UI_PROOF_MANIFEST_SHA256;humanVisualReview='required'} (Join-Path $out 'result.json')
    } finally { Pop-Location }
}
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Run only on the authorized disposable GitHub-hosted Windows native UI runner.' }
$Artifacts = [IO.Path]::GetFullPath($Artifacts)
$AfterSource = (Resolve-Path -LiteralPath $AfterSource).Path
if (Test-Path $Artifacts) { throw 'Artifact destination already exists; do not admit stale proof.' }
New-Item -ItemType Directory -Path $Artifacts -Force | Out-Null
Start-Transcript -Path (Join-Path $Artifacts 'native-proof.log')
$scoped = @('OPENCLAW_REPO_ROOT','OPENCLAW_TRAY_DATA_DIR','OPENCLAW_TRAY_APPDATA_DIR','OPENCLAW_TRAY_LOCALAPPDATA_DIR','OPENCLAW_UI_PROOF_DIR','OPENCLAW_UI_PROOF_FREEZE_DIR','OPENCLAW_UI_PROOF_MANIFEST_SHA256','GitVersion_NoNormalizeEnabled','GitVersion_NoFetchEnabled')
$previous = @{}
foreach ($name in $scoped) { $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
    foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SHA256SUMS')) {
        if ($line -notmatch '^([A-F0-9]{64})  ([A-Za-z0-9._-]+)$') { throw 'Invalid harness seal.' }
        if ((Hash (Join-Path $PSScriptRoot $Matches[2])) -cne $Matches[1]) { throw "Harness seal mismatch: $($Matches[2])" }
    }
    $pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'source-pins.json') -Raw | ConvertFrom-Json
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $session = (Get-Process -Id $PID).SessionId
    $desktopOwners = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object {
        $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
        @{pid=$_.ProcessId;sessionId=$_.SessionId;sid=$owner.Sid}
    })
    Save-Json @{user=$identity.Name;sid=$identity.User.Value;sessionId=$session;desktopOwners=$desktopOwners;imageOS=$env:ImageOS;imageVersion=$env:ImageVersion;runnerOS=$env:RUNNER_OS;runId=$env:GITHUB_RUN_ID} (Join-Path $Artifacts 'desktop-owner.json')
    if ($session -eq 0 -or !($desktopOwners | Where-Object {$_.sid -ceq $identity.User.Value -and $_.sessionId -eq $session})) { throw 'Runner is not executing as its interactive desktop owner. Do not use SSH/session0 or transfer ownership.' }
    foreach ($source in @($AfterSource)) {
        $exact = $source.Replace('\','/')
        $PSNativeCommandUseErrorActionPreference = $false
        $existing = @(& git config --global --get-all safe.directory)
        $PSNativeCommandUseErrorActionPreference = $true
        if ($existing -cnotcontains $exact) { & git config --global --add safe.directory $exact }
    }
    Assert-Source $AfterSource $pin.After
    $candidate = Get-Content (Join-Path $PSScriptRoot 'candidate-source.json') -Raw | ConvertFrom-Json
    $patch = Join-Path $PSScriptRoot 'candidate.patch'
    if ((Hash $patch) -cne $candidate.patchSha256) { throw 'Candidate patch seal mismatch.' }
    Invoke-Git $AfterSource @('apply','--check','--whitespace=error',$patch)
    Invoke-Git $AfterSource @('apply','--whitespace=error',$patch)
    Assert-CandidateSource $AfterSource

    # Check only prerequisites needed by the successful ordinary UI CI lane.
    $sdk = (& dotnet --version).Trim()
    if ([version]$sdk -lt [version]'10.0.403' -or [version]$sdk -ge [version]'11.0') { throw '.NET SDK 10.0.403+ is required.' }
    $kit = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Windows Kits/10'
    foreach ($file in @('Include/10.0.26100.0/um/Windows.h','Lib/10.0.26100.0/um/x64/kernel32.lib','bin/10.0.26100.0/x64/makepri.exe')) { if (!(Test-Path (Join-Path $kit $file))) { throw "Required installed Windows SDK 26100 file absent: $file" } }
    Save-Json @{dotnetSdk=$sdk;windowsSdk='10.0.26100.0';boundary='ordinary x64 native UI build';publish='not tested';nativeSpeech='not tested; source-owned fallback unchanged'} (Join-Path $Artifacts 'prerequisites.json')
    [xml]$props = Get-Content -LiteralPath (Join-Path $AfterSource 'Directory.Build.props') -Raw
    $version = $props.SelectSingleNode('/Project/PropertyGroup/MicrosoftWindowsAppSDKVersion').InnerText.Trim()
    if ($version -cne '2.6.4') { throw 'Reviewed Windows App SDK version changed.' }
    $channel = [regex]::Match($version,'^\d+\.\d+').Value
    $url = "https://aka.ms/windowsappsdk/$channel/$version/windowsappruntimeinstall-x64.exe"
    $installer = Join-Path $env:RUNNER_TEMP 'Llama-WindowsAppRuntimeInstall-x64.exe'
    Invoke-WebRequest -Uri $url -OutFile $installer
    if ((Get-Item $installer).Length -ne 124949816 -or (Hash $installer) -cne '9BF9C28BFA745A5D3C88B3DA29B5C7BEC0DC88B42FAFA3F918EF0B85EA9BBA33') { throw 'Windows App SDK 2.6.4 installer bytes differ from the complete reviewed Microsoft-signed installer.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    $signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
    $installerInfo = @{url=$url;sha256=(Hash $installer);bytes=(Get-Item $installer).Length;signature=$signature.Status.ToString();signer=$signer;sid=$identity.User.Value;sessionId=$session;sdkVersion=$version}
    Save-Json $installerInfo (Join-Path $Artifacts 'runtime-installer.json')
    if ($signature.Status -ne 'Valid' -or $signer -notmatch 'CN=Microsoft Corporation') { throw 'Runtime installer is not valid Microsoft-signed bytes.' }
    $PSNativeCommandUseErrorActionPreference = $false
    & $installer --quiet
    $installerInfo['exitCode'] = $LASTEXITCODE
    $PSNativeCommandUseErrorActionPreference = $true
    Save-Json $installerInfo (Join-Path $Artifacts 'runtime-installer.json')
    if ($LASTEXITCODE -ne 0) { throw 'WindowsAppRuntime installer failed.' }
    # The signed 2.6.4 installer/AppX receipts identify family .2, version 2.6.4.0.
    # The SDK major/minor channel is not the package-family suffix.
    $packages = @(Get-AppxPackage -Name "Microsoft.WindowsAppRuntime.2" | Select-Object Name,PackageFullName,Version,Architecture,Status,IsFramework,Publisher)
    Save-Json $packages (Join-Path $Artifacts 'runtime-current-user-registration.json')
    if (!($packages | Where-Object {$_.Architecture.ToString() -eq 'X64' -and $_.Status.ToString() -eq 'Ok' -and $_.IsFramework -and [version]$_.Version -ge [version]'2.6.4.0'})) { throw 'Runtime framework is not registered for the current interactive user.' }
    $probe = Join-Path $env:RUNNER_TEMP 'llama-bootstrap-probe'
    New-Item -ItemType Directory -Path $probe | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'Program.cs'),(Join-Path $PSScriptRoot 'BootstrapProbe.csproj') $probe
    & dotnet build (Join-Path $probe 'BootstrapProbe.csproj') -c Release -r win-x64
    $probeDll = Join-Path $probe 'bin/Release/net10.0-windows10.0.22621.0/win-x64/BootstrapProbe.dll'
    $probeOutput = & dotnet $probeDll $version
    $probeOutput | Set-Content (Join-Path $Artifacts 'bootstrap.json') -Encoding utf8NoBOM
    $bootstrap = $probeOutput | ConvertFrom-Json
    if ($bootstrap.status -cne 'passed' -or $bootstrap.sid -cne $identity.User.Value -or $bootstrap.sessionId -ne $session -or $bootstrap.majorMinor -ne 131078 -or $bootstrap.versionTag -cne '') { throw 'Source-exact stable Bootstrap.Initialize(0x00020006, empty tag) was not proven under the capture user.' }
    Save-Json @{probeDllSha256=(Hash $probeDll);sourceSha256=(Hash (Join-Path $PSScriptRoot 'Program.cs'));projectSha256=(Hash (Join-Path $PSScriptRoot 'BootstrapProbe.csproj'))} (Join-Path $Artifacts 'bootstrap-binary.json')
    & (Join-Path $AfterSource 'scripts/Set-CiDesktopResolution.ps1')
    Copy-Item (Join-Path $env:GITHUB_WORKSPACE 'TestResults/Desktop/geometry.json') (Join-Path $Artifacts 'desktop-geometry.json')
    Run-Stage $AfterSource 'After' $pin.After
    Run-Closeout $AfterSource
    Save-Json @{status='native-tests-passed-visual-review-required';baseHead=$pin.After.head;dirtyCandidatePatchSha256=$candidate.patchSha256;executed=15;passed=15;skipped=0;newPngs=7;retainedBefore='baseline-reference.json, run41450598883, not rerun';fullCloseout='passed with nonzero Shared/Tray execution';gateway='synthetic in-process PageTransport fixture';inference='not tested';pairing='not tested';liveProvider='not tested'} (Join-Path $Artifacts 'result.json')
} catch {
    Save-Json @{status='failed';error=($_ | Out-String)} (Join-Path $Artifacts 'failure.json')
    throw
} finally {
    foreach ($name in $scoped) { [Environment]::SetEnvironmentVariable($name,$previous[$name]) }
    Stop-Transcript
    $hashes = @(Get-ChildItem -LiteralPath $Artifacts -Recurse -File | ForEach-Object {@{path=[IO.Path]::GetRelativePath($Artifacts,$_.FullName);sha256=(Hash $_.FullName);bytes=$_.Length}})
    Save-Json $hashes (Join-Path $Artifacts 'artifact-hashes.json')
}
