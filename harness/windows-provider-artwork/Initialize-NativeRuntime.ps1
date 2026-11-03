[CmdletBinding()]
param([Parameter(Mandatory)][string]$BeforeSource,[Parameter(Mandatory)][string]$AfterSource,[Parameter(Mandatory)][string]$Artifacts,[switch]$ExecutionAuthorized)
. (Join-Path $PSScriptRoot 'Proof.Common.ps1')
if (!$ExecutionAuthorized) { throw 'Runtime provisioning needs separately authorized reviewed CI execution.' }
$BeforeSource = Resolve-ExistingDirectory $BeforeSource
$AfterSource = Resolve-ExistingDirectory $AfterSource
$Artifacts = Resolve-ExistingDirectory $Artifacts
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Only the authorized disposable GitHub-hosted Windows runner is supported.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $session = (Get-Process -Id $PID).SessionId
    $desktopOwners = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | ForEach-Object {
        $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
        @{pid=$_.ProcessId;sessionId=$_.SessionId;sid=$owner.Sid}
    })
    Save-Json @{user=$identity.Name;sid=$identity.User.Value;sessionId=$session;desktopOwners=$desktopOwners;imageOS=$env:ImageOS;imageVersion=$env:ImageVersion;runnerOS=$env:RUNNER_OS;runId=$env:GITHUB_RUN_ID} (Join-Path $Artifacts 'desktop-owner.json')
    if ($session -eq 0 -or !($desktopOwners | Where-Object {$_.sid -ceq $identity.User.Value -and $_.sessionId -eq $session})) { throw 'Runner is not executing as its interactive desktop owner. Do not use SSH/session0 or transfer ownership.' }
    # Fresh source checkouts belong to this user; retain Git trust guards. No global safe.directory edits.
    # Check only prerequisites needed by the successful ordinary UI CI lane.
    Push-Location $AfterSource
    try { $sdk = (& dotnet --version).Trim() } finally { Pop-Location }
    if ($sdk -cne '10.0.403') { throw 'The exact qualified .NET SDK 10.0.403 is required.' }
    $kit = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Windows Kits/10'
    foreach ($file in @('Include/10.0.26100.0/um/Windows.h','Lib/10.0.26100.0/um/x64/kernel32.lib','bin/10.0.26100.0/x64/makepri.exe')) { if (!(Test-Path (Join-Path $kit $file))) { throw "Required installed Windows SDK 26100 file absent: $file" } }
    Save-Json @{dotnetSdk=$sdk;windowsSdk='10.0.26100.0';boundary='ordinary x64 native UI build';publish='not tested';nativeSpeech='not tested; source-owned fallback unchanged'} (Join-Path $Artifacts 'prerequisites.json')
    [xml]$props = Get-Content -LiteralPath (Join-Path $AfterSource 'Directory.Build.props') -Raw
    $version = $props.SelectSingleNode('/Project/PropertyGroup/MicrosoftWindowsAppSDKVersion').InnerText.Trim()
    if ($version -cne '2.6.4') { throw 'Reviewed Windows App SDK version changed.' }
    [xml]$beforeProps=Get-Content (Join-Path $BeforeSource 'Directory.Build.props') -Raw
    if ($beforeProps.SelectSingleNode('/Project/PropertyGroup/MicrosoftWindowsAppSDKVersion').InnerText.Trim() -cne $version) { throw 'Before/After source runtime contracts differ.' }
    $channel = [regex]::Match($version,'^\d+\.\d+').Value
    $url = "https://aka.ms/windowsappsdk/$channel/$version/windowsappruntimeinstall-x64.exe"
    $runtimeRoot=Join-Path $env:RUNNER_TEMP ('provider-artwork-runtime-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
    $installer = Join-Path $runtimeRoot 'WindowsAppRuntimeInstall-x64.exe'
    Invoke-WebRequest -Uri $url -OutFile $installer
    if ((Get-Item $installer).Length -ne 124949816 -or (Hash $installer) -cne '9bf9c28bfa745a5d3c88b3da29b5c7bec0dc88b42fafa3f918ef0b85ea9bba33') { throw 'Windows App SDK 2.6.4 installer bytes differ from the complete reviewed Microsoft-signed installer.' }
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
    $probe = Join-Path $runtimeRoot 'bootstrap-probe'
    New-Item -ItemType Directory -Path $probe | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'Program.cs'),(Join-Path $PSScriptRoot 'BootstrapProbe.csproj') $probe
    Copy-Item (Join-Path $AfterSource 'global.json') (Join-Path $probe 'global.json')
    Push-Location $probe
    try {
    & dotnet build (Join-Path $probe 'BootstrapProbe.csproj') -c Release -r win-x64
    $probeDll = Join-Path $probe 'bin/Release/net10.0-windows10.0.22621.0/win-x64/BootstrapProbe.dll'
    $probeOutput = & dotnet $probeDll $version
    } finally { Pop-Location }
    $probeOutput | Set-Content (Join-Path $Artifacts 'bootstrap.json') -Encoding utf8NoBOM
    $bootstrap = $probeOutput | ConvertFrom-Json
    if ($bootstrap.status -cne 'passed' -or $bootstrap.sid -cne $identity.User.Value -or $bootstrap.sessionId -ne $session -or $bootstrap.majorMinor -ne 131078 -or $bootstrap.versionTag -cne '') { throw 'Source-exact stable Bootstrap.Initialize(0x00020006, empty tag) was not proven under the capture user.' }
    Save-Json @{probeDllSha256=(Hash $probeDll);sourceSha256=(Hash (Join-Path $PSScriptRoot 'Program.cs'));projectSha256=(Hash (Join-Path $PSScriptRoot 'BootstrapProbe.csproj'))} (Join-Path $Artifacts 'bootstrap-binary.json')
    & (Join-Path $AfterSource 'scripts/Set-CiDesktopResolution.ps1')
    Copy-Item (Join-Path $env:GITHUB_WORKSPACE 'TestResults/Desktop/geometry.json') (Join-Path $Artifacts 'desktop-geometry.json')

