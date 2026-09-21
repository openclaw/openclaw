# PR112055 native proof: no substituted Winget, MSI metadata, Node, or Check-Node.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('healthy','stale-msi','failed-repair','unsupported-node','non-msi')][string]$Scenario,
    [Parameter(Mandatory)][string]$CandidateRoot,
    [Parameter(Mandatory)][string]$ExpectedHead,
    [Parameter(Mandatory)][string]$ProofRoot,
    [Parameter(Mandatory)][string]$WorkRoot
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
New-Item -ItemType Directory -Path $ProofRoot -Force | Out-Null
$proof = [ordered]@{ scenario=$Scenario; result='unqualified'; cleanup='not-started'; candidate=$ExpectedHead; commands=@(); failures=@() }
$originalPaths = @{}
$breakpoints = @()
$ownedProduct = $null
$portableOwned = $false
$localManifestsEnabled = $false
$setupStarted = $false
$transcriptStarted = $false
$blockerHandle = $null
$runtime = $null
$started = Get-Date
$global:WingetProofTrace = [ordered]@{ install=@(); repair=@(); checkCount=0 }
function Assert-Proof([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$Name) {
    $output = @(& $Exe @Arguments 2>&1)
    $code = $LASTEXITCODE
    $output | Set-Content -LiteralPath (Join-Path $ProofRoot "$Name.log")
    $proof.commands += @{ name=$Name; executable=$Exe; arguments=$Arguments; exit=$code }
    return $code
}
function Get-NodeRegistration {
    # Read registration; never fabricate or edit Windows Installer records.
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path $root) {
            Get-ChildItem $root | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Node.js' } |
                Select-Object PSPath, PSChildName, DisplayName, DisplayVersion, InstallLocation, WindowsInstaller, UninstallString
        }
    }
}
function Remove-OwnedMsi([string]$Product, [string]$Label) {
    Assert-Proof ($Product -match '^\{[0-9A-Fa-f-]{36}\}$') 'Invalid MSI ProductCode.'
    # msiexec is a GUI executable: direct invocation can return before MSI exits.
    # Wait for the real process tree and read its exit code, never stale LASTEXITCODE.
    $exe = "$env:WINDIR\System32\msiexec.exe"
    $log = Join-Path $ProofRoot "$Label-msi.log"
    $arguments = @('/x',$Product,'/qn','/norestart','/l*v',('"{0}"' -f $log))
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru
    $code = $process.ExitCode
    $proof.commands += @{ name=$Label; executable=$exe; arguments=$arguments; exit=$code; processId=$process.Id; waited=$true }
    $process.Dispose()
    Assert-Proof ($code -in @(0,1605,3010)) "MSI uninstall failed: $code."
    Assert-Proof (@(Get-NodeRegistration | Where-Object PSChildName -eq $Product).Count -eq 0) 'MSI registration survived uninstall.'
}
function Get-RuntimeFacts([string]$Path, [string]$Name) {
    $js = @'
const out={version:process.version,execPath:process.execPath};
let db;
try {
 const {DatabaseSync}=require('node:sqlite'); db=new DatabaseSync(':memory:');
 out.sqlite=db.prepare('select sqlite_version() as v').get().v;
 const value='a\u0000b\u0000',bytes=Buffer.from(value),json=JSON.stringify({value});
 db.exec('create table p(t TEXT,b BLOB,j TEXT)'); db.prepare('insert into p values(?,?,?)').run(value,bytes,json);
 const row=db.prepare('select * from p').get();
 out.text=row.t===value; out.blob=Buffer.from(row.b).equals(bytes); out.json=JSON.parse(row.j).value===value;
} catch(e) {out.error=String(e)} finally {db?.close()}
console.log(JSON.stringify(out));
'@
    $output = @($js | & $Path - 2>$null)
    Assert-Proof ($LASTEXITCODE -eq 0) 'Authentic Node probe failed to execute.'
    $facts = ($output -join "`n") | ConvertFrom-Json
    $facts | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $ProofRoot "$Name.json")
    return $facts
}
try {
    Assert-Proof ($env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_OS -eq 'Windows') 'Only a fresh disposable GitHub-hosted Windows VM is authorized.'
    Assert-Proof ($ExpectedHead -ceq 'a32b79e73b358fbcd068bbf86ef8032333d8d7c8') 'Unexpected candidate.'
    Assert-Proof (-not (Test-Path -LiteralPath $WorkRoot)) 'Owned staging already exists.'
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $proof.host = @{ administrator=$admin; interactive=[Environment]::UserInteractive; sessionId=(Get-Process -Id $PID).SessionId; image=$env:ImageVersion; powershell=$PSVersionTable.PSVersion.ToString(); freeBytes=(Get-PSDrive C).Free }
    Assert-Proof $admin 'Effective administrator token is required for real MSI lifecycle.'
    # Headless execution is recorded, not relabeled as a console. Native commands
    # below must actually complete; any interactive-only requirement remains a gap.
    $proof.host.storage = @()
    $destinations = @($CandidateRoot,$ProofRoot,$WorkRoot,$env:ProgramFiles,$env:TEMP)
    $driveNames = @($destinations | ForEach-Object { (Split-Path -Path $_ -Qualifier).TrimEnd(':') } | Sort-Object -Unique)
    foreach ($driveName in $driveNames) {
        $disk = Get-PSDrive -Name $driveName
        $proof.host.storage += @{ drive=$driveName; root=$disk.Root; freeBytes=$disk.Free }
        Assert-Proof ($disk.Free -ge 8GB) "Insufficient measured capacity on destination drive $driveName."
    }
    $resolvedHead = (& git -C $CandidateRoot rev-parse HEAD).Trim()
    Assert-Proof ($LASTEXITCODE -eq 0 -and $resolvedHead -ceq $ExpectedHead) 'Candidate checkout mismatch.'
    $installer = Join-Path $CandidateRoot 'scripts/install.ps1'
    $hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    $proof.installerSha256 = $hash
    Assert-Proof ($hash -ceq '98f882491f615eb61b472c9d589aeb1c478da3afdb9dc740c9c9722dec2a5f7d') 'Installer bytes differ from reviewed candidate.'
    New-Item -ItemType Directory -Path $WorkRoot | Out-Null
    $setupStarted = $true
    Start-Transcript -Path (Join-Path $ProofRoot 'transcript.log') | Out-Null
    $transcriptStarted = $true
    foreach ($scope in @('Machine','User','Process')) { $originalPaths[$scope] = [Environment]::GetEnvironmentVariable('Path',$scope) }
    # The image is disposable. Remove its enumerated MSI Node baseline using MSI,
    # not hand-written registry state; never do this on a paired/persistent host.
    $baseline = @(Get-NodeRegistration)
    $proof.imageNodeBaseline = $baseline
    foreach ($entry in $baseline) {
        Assert-Proof ($entry.WindowsInstaller -eq 1) 'Unexpected non-MSI image Node; baseline requires host-owner inspection.'
        Remove-OwnedMsi $entry.PSChildName 'remove-image-node'
    }
    foreach ($scope in @('Machine','User','Process')) {
        $clean = @($originalPaths[$scope] -split ';' | Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $_ 'node.exe')) }) -join ';'
        [Environment]::SetEnvironmentVariable('Path',$clean,$scope)
    }
    Assert-Proof (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) 'Foreign Node is still discoverable.'
    if (-not (Get-Command winget -CommandType Application -ErrorAction SilentlyContinue)) {
        Install-Module Microsoft.WinGet.Client -Repository PSGallery -Scope CurrentUser -Force
        Import-Module Microsoft.WinGet.Client
        Repair-WinGetPackageManager -AllUsers
    }
    $winget = (Get-Command winget -CommandType Application -ErrorAction Stop).Source
    $proof.winget = @{ path=$winget; version=(& $winget --version | Out-String).Trim(); sha256=(Get-FileHash $winget -Algorithm SHA256).Hash }
    Assert-Proof ((Invoke-Native $winget @('source','update','--name','winget','--disable-interactivity') 'source-update') -eq 0) 'Winget catalog refresh failed.'
    # Immutable upstream artifact contract; a moved catalog must fail stale-HRESULT
    # reproduction, not silently count a normal upgrade as repair acceptance.
    $manifestBase = 'https://raw.githubusercontent.com/microsoft/winget-pkgs/ed043bfd0afedc6652936921fbef12b96e854862/manifests/o/OpenJS/NodeJS/LTS/24.19.0'
    $manifestDirectory = Join-Path $WorkRoot 'manifest'
    New-Item -ItemType Directory -Path $manifestDirectory | Out-Null
    $manifestFiles = @('OpenJS.NodeJS.LTS.yaml','OpenJS.NodeJS.LTS.installer.yaml','OpenJS.NodeJS.LTS.locale.en-US.yaml')
    $proof.manifest = @{ base=$manifestBase; files=@(); version='24.19.0'; productCode='{89850E15-F7D6-476D-972E-F8F5215E4498}' }
    foreach ($name in $manifestFiles) {
        $destination = Join-Path $manifestDirectory $name
        Invoke-WebRequest "$manifestBase/$name" -OutFile $destination
        Copy-Item -LiteralPath $destination -Destination (Join-Path $ProofRoot $name)
        $proof.manifest.files += @{ name=$name; sha256=(Get-FileHash $destination).Hash }
    }
    # Native local-manifest installation enforces the pinned InstallerSha256,
    # instead of resolving the setup artifact from today's mutable catalog.
    # Candidate install/repair below still use their unmodified public source.
    if ($Scenario -ne 'unsupported-node') {
        Assert-Proof ((Invoke-Native $winget @('settings','--enable','LocalManifestFiles') 'enable-local-manifests') -eq 0) 'Native local-manifest setup unavailable.'
        $localManifestsEnabled = $true
    }
    . $installer -DryRun -NoOnboard
    $DryRun = $false
    # These read-only debugger observers preserve command resolution, arguments,
    # native HRESULTs and real Check-Node. They do not replace a function or return.
    $lines = Get-Content -LiteralPath $installer
    $installLine = @((0..($lines.Count-1)) | Where-Object { $lines[$_] -match '^        \$wingetInstallExitCode = \$LASTEXITCODE$' })
    $repairLine = @((0..($lines.Count-1)) | Where-Object { $lines[$_] -match '^            \$wingetRepairExitCode = \$LASTEXITCODE$' })
    Assert-Proof ($installLine.Count -eq 1 -and $repairLine.Count -eq 1) 'Expected exact repair observation sites.'
    $breakpoints += Set-PSBreakpoint -Script $installer -Line ($installLine[0]+4) -Action { $global:WingetProofTrace.install += $wingetInstallExitCode }
    $breakpoints += Set-PSBreakpoint -Script $installer -Line ($repairLine[0]+2) -Action { $global:WingetProofTrace.repair += $wingetRepairExitCode }
    $breakpoints += Set-PSBreakpoint -Command Check-Node -Action { $global:WingetProofTrace.checkCount++ }
    # Run the exact Main prefix including its final Node recheck. Stop before
    # unrelated npm/OpenClaw installation. This is not full Main/E2E proof.
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$parseErrors)
    Assert-Proof ($parseErrors.Count -eq 0) 'Candidate parse failed.'
    $main = $ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Main'},$false)
    $boundary = @($main.Body.EndBlock.Statements | Where-Object { $_.Extent.Text -ceq '$finalGitDir = $null' })
    Assert-Proof ($boundary.Count -eq 1) 'Exact Main Node-gate boundary not found.'
    $source = Get-Content $installer -Raw
    $prefix = $source.Substring($main.Body.Extent.StartOffset+1,$boundary[0].Extent.StartOffset-$main.Body.Extent.StartOffset-1)
    $prefix | Set-Content (Join-Path $ProofRoot 'main-node-gate.ps1')
    $proof.mainGateScope = 'Exact Main prefix through final Node recheck; no npm/install/onboarding E2E claim'
    if ($Scenario -eq 'unsupported-node') {
        $version = '22.23.2'
        $file = "node-v$version-win-x64.zip"
        Invoke-WebRequest "https://nodejs.org/dist/v$version/$file" -OutFile (Join-Path $WorkRoot $file)
        Invoke-WebRequest "https://nodejs.org/dist/v$version/SHASUMS256.txt" -OutFile (Join-Path $ProofRoot 'unsupported-SHASUMS256.txt')
        $sum = @(Get-Content (Join-Path $ProofRoot 'unsupported-SHASUMS256.txt') | Where-Object { $_ -match ('\s+'+[regex]::Escape($file)+'$') })
        Assert-Proof ($sum.Count -eq 1 -and (Get-FileHash (Join-Path $WorkRoot $file)).Hash -eq ($sum[0] -split '\s+')[0]) 'Unsupported official Node archive hash mismatch.'
        Expand-Archive (Join-Path $WorkRoot $file) -DestinationPath $WorkRoot
        $runtime = Join-Path $WorkRoot "node-v$version-win-x64/node.exe"
        $proof.unsupported = Get-RuntimeFacts $runtime 'unsupported-runtime'
        Assert-Proof (-not (Check-Node -NodePath $runtime)) 'Unsupported real Node was accepted.'
        Assert-Proof ($global:WingetProofTrace.install.Count -eq 0 -and $global:WingetProofTrace.repair.Count -eq 0) 'Unsupported-version gate unexpectedly installed/repaired.'
    } else {
        $type = if ($Scenario -eq 'non-msi') { 'zip' } else { 'wix' }
        $scope = if ($Scenario -eq 'non-msi') { 'user' } else { 'machine' }
        $arguments = @('install','--manifest',$manifestDirectory,'--architecture','x64','--installer-type',$type,'--scope',$scope,'--accept-package-agreements','--accept-source-agreements','--disable-interactivity','--silent')
        if ($Scenario -eq 'non-msi') {
            $portableOwned = $true
            $arguments += @('--location',(Join-Path $WorkRoot 'portable'))
        } else { $ownedProduct = $proof.manifest.productCode }
        Assert-Proof ((Invoke-Native $winget $arguments 'setup-node') -eq 0) 'Exact native package setup failed.'
        Refresh-ProcessPath
        Add-InstalledNodeToProcessPath | Out-Null
        $proof.registration = @(Get-NodeRegistration)
        if ($Scenario -eq 'non-msi') {
            Assert-Proof (@($proof.registration | Where-Object WindowsInstaller -eq 1).Count -eq 0) 'Portable control unexpectedly has MSI registration.'
            $executables = @(Get-ChildItem (Join-Path $WorkRoot 'portable') -Filter node.exe -Recurse -File)
            Assert-Proof ($executables.Count -eq 1) 'Portable install location is ambiguous.'
            $runtime = $executables[0].FullName
        } else {
            Assert-Proof (@($proof.registration | Where-Object { $_.PSChildName -eq $ownedProduct -and $_.WindowsInstaller -eq 1 -and $_.DisplayVersion -eq '24.19.0' }).Count -eq 1) 'Real MSI metadata differs from pinned manifest.'
            $runtime = Join-Path $env:ProgramFiles 'nodejs/node.exe'
            Assert-Proof ((Get-AuthenticodeSignature $runtime).Status -eq 'Valid') 'Installed Node signature is invalid.'
        }
        $proof.before = Get-RuntimeFacts $runtime 'runtime-before'
        Assert-Proof (Check-Node -NodePath $runtime) 'Pinned native package fails existing runtime gate.'
        $proof.nodeBeforeSha256 = (Get-FileHash $runtime).Hash
        if ($Scenario -ne 'healthy') {
            Move-Item -LiteralPath $runtime -Destination (Join-Path $WorkRoot 'original-node.exe')
            if ($Scenario -eq 'failed-repair') {
                # Real filesystem fault: MSI cannot replace a directory at the
                # executable path. Keep a held child to prevent recursive removal.
                New-Item -ItemType Directory -Path $runtime | Out-Null
                $blockerHandle = [IO.File]::Open((Join-Path $runtime 'owned-blocker'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
            }
            Assert-Proof (-not (Check-Node)) 'Stale setup still discovers a usable foreign runtime.'
        }
        $global:WingetProofTrace.install=@(); $global:WingetProofTrace.repair=@(); $global:WingetProofTrace.checkCount=0
        $global:WingetProofMainReached = $false
        $script:InstallExitCode = 0
        $gate = [scriptblock]::Create($prefix + "`n`$global:WingetProofMainReached = `$true")
        & $gate
        $proof.mainReached = $global:WingetProofMainReached
        $proof.installExit = $script:InstallExitCode
        $proof.trace = $global:WingetProofTrace
        if ($Scenario -eq 'healthy') {
            Assert-Proof ($proof.mainReached -and $proof.trace.install.Count -eq 0 -and $proof.trace.repair.Count -eq 0) 'Healthy Main gate invoked installation/repair or failed.'
        } else {
            Assert-Proof ($proof.trace.install.Count -eq 1 -and $proof.trace.install[0] -eq -1978335189) 'Native install did not reproduce stale HRESULT 0x8A15002B; not repair acceptance.'
            Assert-Proof ($proof.trace.repair.Count -eq 1) 'Expected exactly one real Winget repair.'
            if ($Scenario -eq 'stale-msi') {
                Assert-Proof ($proof.trace.repair[0] -eq 0 -and $proof.mainReached -and $proof.installExit -eq 0) 'Real MSI repair or final Main Node gate failed.'
                Assert-Proof ($proof.trace.checkCount -ge 4) 'Final Main Node recheck not observed.'
                $proof.after = Get-RuntimeFacts $runtime 'runtime-after'
                Assert-Proof ((Check-Node) -and $proof.after.text -and $proof.after.blob -and $proof.after.json) 'Repaired native Node/SQLite checks failed.'
            } else {
                Assert-Proof ($proof.trace.repair[0] -ne 0 -and -not $proof.mainReached -and $proof.installExit -ne 0) 'Failed/unsupported real repair was accepted.'
                Assert-Proof (-not (Check-Node)) 'Negative control unexpectedly left a healthy runtime.'
            }
        }
    }
    $proof.result = 'passed'
} catch {
    $proof.failures += $_.Exception.Message
    $proof.result = 'failed-or-unqualified'
} finally {
    if ($breakpoints.Count) { $breakpoints | Remove-PSBreakpoint }
    if ($blockerHandle) { $blockerHandle.Dispose() }
    try {
        if ($runtime -and (Test-Path -LiteralPath $runtime -PathType Container) -and $Scenario -eq 'failed-repair') { Remove-Item -LiteralPath $runtime -Recurse -Force }
        if ($ownedProduct) { Remove-OwnedMsi $ownedProduct 'cleanup-owned-msi' }
        if ($portableOwned) {
            $code = Invoke-Native $winget @('uninstall','--id','OpenJS.NodeJS.LTS','--exact','--source','winget','--scope','user','--silent','--disable-interactivity') 'cleanup-owned-portable'
            Assert-Proof ($code -eq 0) 'Portable native cleanup failed.'
            Assert-Proof (@(Get-NodeRegistration).Count -eq 0) 'Portable registration remains.'
        }
        if ($localManifestsEnabled) {
            Assert-Proof ((Invoke-Native $winget @('settings','--disable','LocalManifestFiles') 'disable-local-manifests') -eq 0) 'Could not disable task-enabled local manifests.'
        }
        if ($setupStarted -and (Test-Path -LiteralPath $WorkRoot)) { Remove-Item -LiteralPath $WorkRoot -Recurse -Force }
        Assert-Proof (-not (Test-Path -LiteralPath $WorkRoot)) 'Task-owned staging survived cleanup.'
        $proof.cleanup = 'verified'
    } catch {
        $proof.cleanup = 'failed'
        $proof.failures += $_.Exception.Message
        $proof.result = 'failed-or-unqualified'
    }
    foreach ($scope in $originalPaths.Keys) { [Environment]::SetEnvironmentVariable('Path',$originalPaths[$scope],$scope) }
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
    # Keep only this fresh VM's diagnostic logs for native command/HRESULT audit.
    $logRoots = @((Join-Path $env:LOCALAPPDATA 'Packages/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe/LocalState/DiagOutputDir'),(Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/DiagOutputDir'))
    New-Item -ItemType Directory -Force -Path (Join-Path $ProofRoot 'winget-logs') | Out-Null
    foreach ($root in $logRoots) {
        if (Test-Path $root) {
            Get-ChildItem $root -File | Where-Object { $_.LastWriteTime -ge $started } | Copy-Item -Destination (Join-Path $ProofRoot 'winget-logs')
        }
    }
    $proof.trace = $global:WingetProofTrace
    $proof | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $ProofRoot 'result.json')
}
if ($proof.result -ne 'passed' -or $proof.cleanup -ne 'verified') { throw 'Native acceptance incomplete; inspect result.json and actual Winget/MSI logs.' }
