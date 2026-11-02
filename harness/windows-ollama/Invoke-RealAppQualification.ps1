[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Artifacts,
    [ValidateSet('Normal','CancelCloseQuit')][string]$Mode = 'Normal',
    [ValidateRange(60,86400)][int]$SoftDeadlineSeconds = 2700,
    [switch]$AuthorizeRealInstall,
    [switch]$DisposableFreshWindows
)
# Preparation alone does not call this driver. This is an opt-in native consumer,
# never Invoke-UiStage, VSTest, --blame-hang, or a tree-killing wait wrapper.
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
    throw 'Only the parent-authorized disposable GitHub-hosted Windows runner is supported; not a live or self-hosted machine.'
}
if (!$AuthorizeRealInstall -or !$DisposableFreshWindows) {
    throw 'Requires separately authorized real installation on an owned disposable fresh Windows user/host.'
}
Assert-Packet
$Source = [IO.Path]::GetFullPath($Source)
$Artifacts = [IO.Path]::GetFullPath($Artifacts)
$sourcePrefix = $Source.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($Artifacts.StartsWith($sourcePrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Artifacts must be outside frozen source.' }
if (Test-Path -LiteralPath $Artifacts) { throw 'Refuse stale real-app artifacts.' }
New-Item -ItemType Directory -Path $Artifacts | Out-Null
$envBefore = [Environment]::GetEnvironmentVariables('Process')
$names = @('OPENCLAW_REPO_ROOT','GitVersion_NoNormalizeEnabled','GitVersion_NoFetchEnabled',
    'OPENCLAW_TRAY_DATA_DIR','OPENCLAW_TRAY_APPDATA_DIR','OPENCLAW_TRAY_LOCALAPPDATA_DIR',
    'OPENCLAW_REAL_APP_PROOF_DIR','OPENCLAW_REAL_APP_MODE','OPENCLAW_REAL_APP_AUTHORIZED',
    'OPENCLAW_REAL_APP_FREEZE','OPENCLAW_REAL_APP_FREEZE_SHA256',
    'OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR','OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD')
$rootProcess = $null
try {
    # Source must be the immutable 21-file product, WITHOUT the independent comparison
    # overlays. Keep that route separate; this driver declares exactly one new overlay.
    Assert-Product $Source
    $overlay = 'tests/OpenClaw.Tray.UITests/RealOllamaAppQualificationTests.cs'
    if (Test-Path (Join-Path $Source $overlay)) { throw 'Refuse preexisting real-app overlay.' }
    $appInstaller = @(Get-AppxPackage -Name Microsoft.DesktopAppInstaller | Where-Object {
        $_.PackageFamilyName -ceq 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe' -and
        $_.Publisher -ceq 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' -and
        $_.Status -eq 'Ok'
    })
    $winget = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Microsoft/WindowsApps/winget.exe'
    if ($appInstaller.Count -ne 1 -or !(Test-Path -LiteralPath $winget)) {
        throw 'Blocked: current first-party App Installer and its current-user WinGet alias are required. No bootstrap, reset, policy, source or alias changes allowed.'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $desktopOwners = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object {
        $_.SessionId -eq $session -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -ceq $identity.User.Value
    })
    if ($session -eq 0 -or $desktopOwners.Count -eq 0) { throw 'Current interactive desktop owner is not established. No ownership transfer or session change is allowed.' }
    $ollamaEnvironmentPresent = @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $_ -like 'OLLAMA_*' }).Count -ne 0
    $ollamaStatePresent = Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ollama')
    if ($ollamaEnvironmentPresent -or $ollamaStatePresent) { throw 'Fresh disposable-user prerequisite failed: existing Ollama environment/state was found. No values, model cache, or private configuration were adopted or changed.' }
    $wingetSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $appInstaller[0].InstallLocation 'winget.exe')
    if ($wingetSignature.Status -ne 'Valid' -or $wingetSignature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
        throw 'App Installer WinGet executable does not have valid current Microsoft publisher trust.'
    }
    $version = (& $winget --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -cne 'v1.29.380') {
        throw "Blocked: reviewed first-party WinGet v1.29.380 required; observed '$version'. Qualify another version separately, do not install one here."
    }
    Save-Json @{version=$version;package=$appInstaller[0].PackageFullName;signatureKind=$appInstaller[0].SignatureKind.ToString();signature=$wingetSignature.Status.ToString();sid=$identity.User.Value;sessionId=$session;existingOllamaState=$ollamaStatePresent;ollamaEnvironmentPresent=$ollamaEnvironmentPresent;alias=$winget;changes=$false} (Join-Path $Artifacts 'winget-prerequisite.json')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'RealOllamaAppQualificationTests.cs') -Destination (Join-Path $Source $overlay)
    $env:OPENCLAW_REPO_ROOT = $Source
    $env:GitVersion_NoNormalizeEnabled = 'true'
    $env:GitVersion_NoFetchEnabled = 'true'
    $env:OPENCLAW_TRAY_DATA_DIR = Join-Path $Artifacts 'profile/data'
    $env:OPENCLAW_TRAY_APPDATA_DIR = Join-Path $Artifacts 'profile/roaming'
    $env:OPENCLAW_TRAY_LOCALAPPDATA_DIR = Join-Path $Artifacts 'profile/local'
    $env:OPENCLAW_REAL_APP_PROOF_DIR = Join-Path $Artifacts 'proof'
    $env:OPENCLAW_REAL_APP_MODE = $Mode
    $env:OPENCLAW_REAL_APP_AUTHORIZED = '1'
    $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_DIR = Join-Path $Artifacts 'proof/images'
    $env:OPENCLAW_MOUNTED_CONTROL_CAPTURE_HEAD = 'd38ebb418c3aba6b24a4d6470def72b2bba4c4a8'
    New-Item -ItemType Directory -Path $env:OPENCLAW_REAL_APP_PROOF_DIR -Force | Out-Null
    $hostProject = Join-Path $Artifacts 'host'
    New-Item -ItemType Directory -Path $hostProject | Out-Null
    $testProject = [Security.SecurityElement]::Escape((Join-Path $Source 'tests/OpenClaw.Tray.UITests/OpenClaw.Tray.UITests.csproj'))
    # WinExe matters: the normal private-desktop wrapper verifies GUI input-idle.
    # The actual consumer lives in the UI test assembly, retaining existing friend visibility.
    @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType><TargetFramework>net10.0-windows10.0.22621.0</TargetFramework>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier><PlatformTarget>x64</PlatformTarget>
    <ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><IsTestProject>false</IsTestProject>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems><UseAppHost>true</UseAppHost>
  </PropertyGroup>
  <ItemGroup><Compile Include="Program.cs"/><ProjectReference Include="$testProject"/></ItemGroup>
</Project>
"@ | Set-Content -LiteralPath (Join-Path $hostProject 'RealAppHost.csproj') -Encoding utf8NoBOM
    @'
internal static class Program
{
    [System.STAThread]
    private static int Main() => OpenClaw.Tray.UITests.RealOllamaAppQualificationTests.RunStandaloneAsync().GetAwaiter().GetResult();
}
'@ | Set-Content -LiteralPath (Join-Path $hostProject 'Program.cs') -Encoding utf8NoBOM
    Invoke-Checked 'dotnet' @('build',(Join-Path $hostProject 'RealAppHost.csproj'),'-c','Debug','-r','win-x64')
    $bin = Join-Path $hostProject 'bin/Debug/net10.0-windows10.0.22621.0/win-x64'
    $uiBin = Join-Path $Source 'tests/OpenClaw.Tray.UITests/bin/Debug/net10.0-windows10.0.22621.0/win-x64'
    # ProjectReference does not transitively copy compiled XBF/PRI. Copy the exact
    # existing UI-test runtime payload, then freeze the complete actual launch directory.
    Copy-Item -Path (Join-Path $uiBin '*') -Destination $bin -Recurse -Force
    $exe = Join-Path $bin 'RealAppHost.exe'
    if (!(Test-Path -LiteralPath $exe)) { throw 'Missing one-shot WinExe.' }
    $evidence = Get-Content (Join-Path $PSScriptRoot 'composed-evidence.json') -Raw | ConvertFrom-Json
    Assert-Files $Source $evidence.files
    if ((Hash (Join-Path $Source $overlay)) -cne (Hash (Join-Path $PSScriptRoot 'RealOllamaAppQualificationTests.cs'))) { throw 'Overlay mismatch.' }
    $actual = @(@(Invoke-Git $Source @('diff','--name-only','HEAD')) + @(Invoke-Git $Source @('ls-files','--others','--exclude-standard')) | Sort-Object -Unique)
    $expected = @($evidence.files.path) + $overlay
    if (@(Compare-Object ($expected | Sort-Object -Unique) $actual).Count -ne 0) { throw 'Unreviewed delta before launch.' }
    $sourceFiles = @(Source-Manifest $Source)
    $freezeFiles = @($sourceFiles | ForEach-Object { @{path=(Join-Path $Source $_.path);sha256=$_.sha256.ToUpperInvariant()} })
    $freezeFiles += @(Get-ChildItem -LiteralPath $hostProject -File | ForEach-Object { @{path=$_.FullName;sha256=(Hash $_.FullName).ToUpperInvariant()} })
    $binaries = @(Get-ChildItem -LiteralPath $bin -File -Recurse | Sort-Object FullName | ForEach-Object { @{path=$_.FullName;sha256=(Hash $_.FullName).ToUpperInvariant()} })
    $freezePath = Join-Path $Artifacts 'real-app-freeze.json'
    Save-Json @{base=$evidence.base;productPatchSha256='fd1d39dfb6184ac07fa359990c4c42a2348b26954543f63d7e4e3794d5ec6a95';
        overlay=@{path=$overlay;sha256=(Hash (Join-Path $Source $overlay))};files=$freezeFiles;binaries=$binaries} $freezePath
    $env:OPENCLAW_REAL_APP_FREEZE = $freezePath
    $env:OPENCLAW_REAL_APP_FREEZE_SHA256 = (Hash $freezePath).ToUpperInvariant()
    $launchPath = Join-Path $Artifacts 'private-desktop.json'
    # DO NOT add -WaitForExit, -ConsoleProcess, -NullSecurityNegativeControl or a
    # timeout collector. The source-owned launcher and DACL/input guards are unchanged.
    & (Join-Path $Source 'scripts/Invoke-PrivateDesktop.ps1') -Executable $exe -DataDirectory $env:OPENCLAW_TRAY_DATA_DIR -McpPort 18766 -NamePrefix RealOllama -ResultPath $launchPath
    # Only after wrapper success (including its final Default-desktop guard) can the
    # child consume app consent. The wrapper's launch-failure cleanup cannot race it.
    $launch = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json
    if ($launch.securityMode -cne 'default-dacl-and-label' -or !$launch.aclAndLabelBytesEqual -or $launch.sharedInputDesktopSwitched) { throw 'Desktop guard refusal; no admission ack.' }
    $rootProcess = [Diagnostics.Process]::GetProcessById([int]$launch.processId)
    if ($rootProcess.StartTime.ToUniversalTime() -ne ([datetime]$launch.processStartUtc).ToUniversalTime() -or
        $rootProcess.MainModule.FileName -ine $exe -or $rootProcess.HasExited) { throw 'Exact root identity unavailable; no admission ack.' }
    [void]$rootProcess.SafeHandle
    Save-Json @{processId=$launch.processId;processStartUtc=$launch.processStartUtc;freezeSha256=$env:OPENCLAW_REAL_APP_FREEZE_SHA256;
        wrapperReturned=$true} (Join-Path $env:OPENCLAW_REAL_APP_PROOF_DIR 'admission-ack.writing')
    Move-Item -LiteralPath (Join-Path $env:OPENCLAW_REAL_APP_PROOF_DIR 'admission-ack.writing') -Destination (Join-Path $env:OPENCLAW_REAL_APP_PROOF_DIR 'admission-ack.json')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (!$rootProcess.WaitForExit(250)) {
        if ($watch.Elapsed.TotalSeconds -ge $SoftDeadlineSeconds) {
            Save-Json @{status='blocked-pending';processId=$launch.processId;processStartUtc=$launch.processStartUtc;
                reason='Soft deadline only. Native root/installer/app left untouched; product drain retains ownership. Do not relaunch or claim settlement.';
                processTerminationRequested=$false;mode=$Mode} (Join-Path $Artifacts 'real-app-result.json')
            throw 'Real-app soft observation deadline reached with settlement unconfirmed. No process termination was requested.'
        }
    }
    $hostReceipt = Get-Content -LiteralPath (Join-Path $env:OPENCLAW_REAL_APP_PROOF_DIR 'testhost.json') -Raw | ConvertFrom-Json
    if ($hostReceipt.processId -ne $launch.processId -or ([datetime]$hostReceipt.processStartUtc).ToUniversalTime() -ne ([datetime]$launch.processStartUtc).ToUniversalTime()) { throw 'Host receipt did not identify exact launched root.' }
    $cases = @(Get-Content -LiteralPath (Join-Path $env:OPENCLAW_REAL_APP_PROOF_DIR 'cases.json') -Raw | ConvertFrom-Json)
    $survival = @{name='app-survives-actual-host-exit';status='blocked';detail='Required app identity not recorded.'}
    $appPath = Join-Path $env:OPENCLAW_REAL_APP_PROOF_DIR 'app-before-exit.json'
    if (Test-Path -LiteralPath $appPath) {
        $app = Get-Content -LiteralPath $appPath -Raw | ConvertFrom-Json
        $live = [Diagnostics.Process]::GetProcessById([int]$app.processId)
        try {
            [void]$live.SafeHandle
            if ($live.HasExited -or $live.StartTime.ToUniversalTime() -ne ([datetime]$app.processStartUtc).ToUniversalTime() -or
                $live.MainModule.FileName -ine $app.path -or $live.SessionId -ne $app.sessionId -or
                $app.sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'App PID/start/path/session changed after host exit.' }
            $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($app.processId)"
            $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
            if ($owner.ReturnValue -ne 0 -or $owner.Sid -cne $app.sid -or $live.HasExited) { throw 'App owner SID unavailable or changed.' }
            $signature = Get-AuthenticodeSignature -LiteralPath $app.path
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=\"?Ollama Inc\.\"?(,|$)') { throw 'App signature not valid Ollama Inc.' }
            $survival = @{name='app-survives-actual-host-exit';status='passed';processId=$app.processId;
                processStartUtc=$app.processStartUtc;path=$app.path;sessionId=$app.sessionId;sid=$app.sid;
                signer=$signature.SignerCertificate.Subject;rootExitCode=$rootProcess.ExitCode;rootNativeHandleSignaled=$true}
        } finally { $live.Dispose() }
    }
    if ((Invoke-Git $Source @('rev-parse','HEAD')).Trim() -cne $evidence.base) { throw 'Source HEAD changed.' }
    Assert-Files $Source $sourceFiles
    foreach ($binary in $binaries) { if ((Hash $binary.path) -cne $binary.sha256.ToLowerInvariant()) { throw 'Frozen launch binary changed.' } }
    $currentSource = @(Source-Manifest $Source)
    if (@(Compare-Object ($sourceFiles.path | Sort-Object) ($currentSource.path | Sort-Object)).Count -ne 0) { throw 'Source inventory changed.' }
    $frameNames = @('real-app-unchecked-review')
    if ($Mode -ceq 'Normal') { $frameNames += 'real-app-installed-needs-model' }
    $images = Join-Path $env:OPENCLAW_REAL_APP_PROOF_DIR 'images'
    if (@(Get-ChildItem -LiteralPath $images -Filter '*.png' -File).Count -ne $frameNames.Count) { throw 'Real-app image inventory differs.' }
    foreach ($name in $frameNames) {
        $frame = Get-Content -LiteralPath (Join-Path $images "$name.json") -Raw | ConvertFrom-Json
        if ((Hash (Join-Path $images "$name.png")) -cne $frame.imageSha256.ToLowerInvariant() -or
            $frame.head -cne $evidence.base -or $frame.assemblySha256.ToLowerInvariant() -cne (Hash (Join-Path $bin 'OpenClaw.Tray.UITests.dll')) -or
            $frame.method -cne 'PrintWindow(PW_RENDERFULLCONTENT); no fallback') { throw 'Real-app frame binding differs.' }
    }
    if ((Hash $freezePath).ToUpperInvariant() -cne $env:OPENCLAW_REAL_APP_FREEZE_SHA256) { throw 'Freeze manifest changed during native execution.' }
    $finalFreeze = Get-Content -LiteralPath (Join-Path $env:OPENCLAW_REAL_APP_PROOF_DIR 'final-freeze.json') -Raw | ConvertFrom-Json
    if (!$finalFreeze.verified -or !$finalFreeze.filesAndLoadedAssembliesVerified -or $finalFreeze.mode -cne $Mode -or
        $finalFreeze.freezeSha256 -cne $env:OPENCLAW_REAL_APP_FREEZE_SHA256 -or $finalFreeze.processId -ne $launch.processId -or
        ([datetime]$finalFreeze.processStartUtc).ToUniversalTime() -ne ([datetime]$launch.processStartUtc).ToUniversalTime()) { throw 'Final freeze success receipt did not bind the actual launched root.' }
    $finalManifest = Get-Content -LiteralPath $freezePath -Raw | ConvertFrom-Json
    foreach ($item in @($finalManifest.files) + @($finalManifest.binaries)) {
        if ((Hash $item.path) -cne $item.sha256.ToLowerInvariant()) { throw 'Final source/generated-host/binary freeze check failed.' }
    }
    $all = @($cases) + $survival
    $selected = @('fresh-inventory','unchecked-consent','real-installer-admission','settlement-releases-lock-and-logger','app-created','final-freeze','actual-application-exit','app-survives-actual-host-exit')
    $selected += if ($Mode -ceq 'Normal') { @('install-needs-model','reuse-running-service') } else { @('cancel-live','close-live','quit-live','cancelled-installation-present') }
    $qualified = $rootProcess.ExitCode -eq 0 -and @($selected | Where-Object { $name=$_; @($all | Where-Object {$_.name -ceq $name -and $_.status -ceq 'passed'}).Count -ne 1 }).Count -eq 0
    Save-Json @{status=$(if($qualified){'selected-boundaries-qualified-other-rows-blocked'}else{'blocked'});mode=$Mode;cases=$all;
        selectedCases=$selected;frames=$frameNames;rootExitCode=$rootProcess.ExitCode;modelDownloaded=$false;actualGatewayReadiness=$false;
        allRequestedBoundariesComplete=$false;processTerminationRequested=$false;freezeSha256=$env:OPENCLAW_REAL_APP_FREEZE_SHA256;
        humanImageReviewRequired=$true} (Join-Path $Artifacts 'real-app-result.json')
    if (!$qualified) { throw 'Selected real-app boundaries did not all qualify; receipt is not a passing native result.' }
} catch {
    $prior = if (Test-Path (Join-Path $Artifacts 'real-app-result.json')) { Get-Content (Join-Path $Artifacts 'real-app-result.json') -Raw | ConvertFrom-Json } else { $null }
    Save-Json @{status='blocked';mode=$Mode;reason=$_.Exception.Message;priorResult=$prior;processTerminationRequested=$false;
        settlementClaimed=$false;retryAllowed=$false;note='Inspect receipts before any later action. No process, app, install or source cleanup was attempted.'} (Join-Path $Artifacts 'real-app-result.json')
    throw
} finally {
    if ($null -ne $rootProcess) { $rootProcess.Dispose() }
    foreach ($name in $names) {
        $value = if ($envBefore.Contains($name)) { [string]$envBefore[$name] } else { [NullString]::Value }
        [Environment]::SetEnvironmentVariable($name,$value,'Process')
    }
}
