# Exact-source end-to-end installer/update proof, only on a disposable hosted Windows VM.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidateRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
    [Parameter(Mandatory = $true)][string]$EvidenceRoot
)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Full installer proof requires PowerShell7 on a disposable GitHub-hosted Windows VM.'
}
$CandidateRoot = [IO.Path]::GetFullPath($CandidateRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$head = (& git -C $CandidateRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead -or $env:PROOF_WORKFLOW_SHA -cne $ExpectedHead) { throw 'Workflow and candidate must name the same published commit.' }
$dirty = @(& git -C $CandidateRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw 'Candidate is not clean.' }
$installer = Join-Path $CandidateRoot 'scripts/install.ps1'
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$engine = (Get-Process -Id $PID).Path
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$root = Join-Path $env:RUNNER_TEMP ('openclaw-git-install-proof-' + [guid]::NewGuid().ToString('N'))
$names = @('USERPROFILE', 'OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_GIT_DIR', 'OPENCLAW_UPDATE_DEV_TARGET_REF', 'APPDATA', 'LOCALAPPDATA', 'NPM_CONFIG_PREFIX', 'npm_config_prefix', 'Path', 'TEMP', 'TMP')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$gateway = $null
$proof = [ordered]@{
    result = 'failed'; sourceSha = $head; workflowSha = $env:PROOF_WORKFLOW_SHA
    installerSha256 = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    baseline = 'openclaw@2026.9.5'; cases = @(); cleanup = 'pending'
}
function Invoke-ProofCommand {
    param([string]$Name, [string]$File, [string[]]$Arguments, [int]$Seconds = 1200, [switch]$ExpectFailure)
    # Arguments are harness-owned paths/flags, never arbitrary command text.
    $quoted = foreach ($value in $Arguments) {
        if ($value.Contains('"') -or $value.EndsWith('\')) { throw 'Unsupported proof argument.' }
        '"' + $value + '"'
    }
    $child = Start-Process -FilePath $File -ArgumentList ($quoted -join ' ') -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $EvidenceRoot "$Name.stdout.log") -RedirectStandardError (Join-Path $EvidenceRoot "$Name.stderr.log")
    try {
        if (-not $child.WaitForExit($Seconds * 1000)) { throw "$Name timed out." }
        $child.WaitForExit()
        if (($ExpectFailure -and $child.ExitCode -eq 0) -or (-not $ExpectFailure -and $child.ExitCode -ne 0)) { throw "$Name returned unexpected exit code $($child.ExitCode)." }
    } finally {
        if (-not $child.HasExited) { $child.Kill($true); $child.WaitForExit() }
        $child.Dispose()
    }
}
function Invoke-ProofInstaller {
    param([string]$Name, [string[]]$Options, [switch]$ExpectFailure)
    Invoke-ProofCommand -Name $Name -File $engine -Arguments (@('-NoLogo', '-NoProfile', '-File', $installer) + $Options + @('-NoOnboard')) -ExpectFailure:$ExpectFailure
}
function Assert-CandidateHead {
    $observed = (& git -C $CandidateRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $observed -cne $ExpectedHead) { throw 'Installer/updater moved away from the pinned candidate.' }
}
function Start-ProofGateway {
    param([string]$Entry, [string]$Name)
    $quotedEntry = '"' + $Entry + '"'
    $script:gateway = Start-Process -FilePath $node -ArgumentList @($quotedEntry, 'gateway', 'run', '--allow-unconfigured') -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $EvidenceRoot "$Name.stdout.log") -RedirectStandardError (Join-Path $EvidenceRoot "$Name.stderr.log")
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    do {
        if ($script:gateway.HasExited) { throw "$Name exited before readiness." }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name never became ready."
}
function Stop-ProofGateway {
    if ($script:gateway) {
        if (-not $script:gateway.HasExited) { $script:gateway.Kill($true); $script:gateway.WaitForExit() }
        $script:gateway.Dispose(); $script:gateway = $null
    }
}
$failure = $null
try {
    $profile = Join-Path $root 'profile'; $prefix = Join-Path $root 'npm'; $temp = Join-Path $root 'temp'
    New-Item -ItemType Directory -Path @($root, $profile, $prefix, $temp) -Force | Out-Null
    $env:USERPROFILE = $profile; $env:OPENCLAW_HOME = $profile
    $env:OPENCLAW_STATE_DIR = Join-Path $profile '.openclaw'
    $env:OPENCLAW_CONFIG_PATH = Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
    $env:APPDATA = Join-Path $profile 'AppData/Roaming'; $env:LOCALAPPDATA = Join-Path $profile 'AppData/Local'
    $env:NPM_CONFIG_PREFIX = $prefix; $env:TEMP = $temp; $env:TMP = $temp
    $env:OPENCLAW_GIT_DIR = $CandidateRoot; $env:OPENCLAW_UPDATE_DEV_TARGET_REF = $ExpectedHead
    $bin = Join-Path $profile '.local/bin'; $wrapper = Join-Path $bin 'openclaw.cmd'
    $env:Path = "$bin;$prefix;$($saved['Path'])"
    # This executes Main, actual pinned pnpm dependency installation/build, launcher publication and Doctor.
    Invoke-ProofInstaller -Name 'fresh-git-main' -Options @('-InstallMethod', 'git', '-GitDir', $CandidateRoot, '-NoGitUpdate')
    Assert-CandidateHead
    if (-not (Test-Path -LiteralPath $wrapper)) { throw 'Fresh installer did not publish the Git launcher.' }
    if ([IO.File]::ReadAllText($wrapper).IndexOf($CandidateRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Fresh launcher targets another checkout.' }
    Invoke-ProofCommand -Name 'fresh-git-version' -File $engine -Arguments @('-NoProfile', '-Command', "& '$wrapper' --version") -Seconds 120
    $working = [Convert]::ToBase64String([IO.File]::ReadAllBytes($wrapper))
    $proof.cases += 'fresh Main/dependencies/build/Doctor/launcher passed'
    # A separate deliberately failing source fixture exercises real dependency/bootstrap and build failure.
    $fault = Join-Path $root 'failed-build'
    New-Item -ItemType Directory -Path $fault | Out-Null
    $pin = (Get-Content (Join-Path $CandidateRoot 'package.json') -Raw | ConvertFrom-Json).packageManager
    @{ name = 'openclaw'; version = '0.0.0'; private = $true; packageManager = $pin; scripts = @{ 'ui:build' = 'node -e process.exit(0)'; build = 'node -e process.exit(42)' } } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $fault 'package.json')
    & git -C $fault init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Fault fixture git init failed.' }
    & git -C $fault add package.json
    if ($LASTEXITCODE -ne 0) { throw 'Fault fixture staging failed.' }
    & git -C $fault -c user.name=InstallerProof -c user.email=installer@example.invalid -c commit.gpgsign=false commit --quiet -m 'Private build-failure fixture; never publish'
    if ($LASTEXITCODE -ne 0) { throw 'Fault fixture commit failed.' }
    Invoke-ProofInstaller -Name 'build-failure-main' -Options @('-InstallMethod', 'git', '-GitDir', $fault, '-NoGitUpdate') -ExpectFailure
    if ((Get-Content (Join-Path $EvidenceRoot 'build-failure-main.stdout.log') -Raw) -notmatch 'pnpm build failed for the Git checkout') { throw 'Fault case failed before reaching the real build; it does not prove rollback.' }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($wrapper)) -cne $working) { throw 'Failed build changed the working launcher.' }
    Invoke-ProofCommand -Name 'post-failure-version' -File $engine -Arguments @('-NoProfile', '-Command', "& '$wrapper' --version") -Seconds 120
    $proof.cases += 'real failed-build Main preserved working launcher'
    # Install the actual released driver, not a candidate CLI pretending to be the old version.
    Invoke-ProofInstaller -Name 'published-driver-install' -Options @('-InstallMethod', 'npm', '-Tag', '2026.9.5')
    $driver = Join-Path $prefix 'node_modules/openclaw/openclaw.mjs'
    $driverPackage = Get-Content (Join-Path $prefix 'node_modules/openclaw/package.json') -Raw | ConvertFrom-Json
    if ($driverPackage.version -cne '2026.9.5') { throw 'Wrong published driver version.' }
    $proof.driverEntrySha256 = (Get-FileHash $driver -Algorithm SHA256).Hash.ToLowerInvariant()
    New-Item -ItemType Directory -Force -Path $env:OPENCLAW_STATE_DIR | Out-Null
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    @{ gateway = @{ mode = 'local'; bind = 'loopback'; port = $port; auth = @{ mode = 'token'; token = [guid]::NewGuid().ToString('N') } }; plugins = @{ allow = @() } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:OPENCLAW_CONFIG_PATH
    Start-ProofGateway -Entry $driver -Name 'published-gateway'
    Invoke-ProofCommand -Name 'published-driver-update' -File $node -Arguments @($driver, 'update', '--channel', 'dev', '--yes', '--json', '--no-restart', '--timeout', '1200')
    Assert-CandidateHead
    if ($gateway.HasExited -or (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 5).StatusCode -ne 200) { throw 'Published Gateway continuity was lost during no-restart update.' }
    $proof.cases += 'published2026.9.5 driver to exact candidate; running Gateway stayed healthy'
    Stop-ProofGateway
    $entry = Join-Path $CandidateRoot 'dist/entry.js'
    Start-ProofGateway -Entry $entry -Name 'candidate-gateway'
    Invoke-ProofCommand -Name 'candidate-doctor' -File $node -Arguments @($entry, 'doctor', '--fix', '--non-interactive') -Seconds 300
    Invoke-ProofCommand -Name 'candidate-gateway-health' -File $node -Arguments @($entry, 'gateway', 'health', '--json') -Seconds 120
    if ($gateway.HasExited) { throw 'Doctor stopped the unmanaged candidate Gateway.' }
    # npm-to-Git uses the updater's npm exposure owner, not the retired installer wrapper.
    $updatedShim = Join-Path $prefix 'openclaw.cmd'
    if (-not (Test-Path -LiteralPath $updatedShim)) { throw 'Upgrade lost the installed command.' }
    Invoke-ProofCommand -Name 'updated-installed-status' -File $engine -Arguments @('-NoProfile', '-Command', "& '$updatedShim' update status --json") -Seconds 120
    $status = Get-Content (Join-Path $EvidenceRoot 'updated-installed-status.stdout.log') -Raw | ConvertFrom-Json
    $update = if ($status.update) { $status.update } else { $status }
    $channel = if ($status.channel.value) { $status.channel.value } else { $status.channel.channel }
    if ($update.installKind -cne 'git' -or $update.git.sha -cne $ExpectedHead -or $channel -cne 'dev') { throw 'Installed command does not resolve to the exact candidate Git owner.' }
    Invoke-ProofCommand -Name 'updated-launcher-version' -File $engine -Arguments @('-NoProfile', '-Command', "& '$updatedShim' --version") -Seconds 120
    $proof.cases += 'candidate Doctor/Gateway RPC/launcher passed'
    Assert-CandidateHead
    $finalDirty = @(& git -C $CandidateRoot status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0 -or $finalDirty.Count) { throw 'Full installer/updater modified candidate source.' }
    $proof.candidateEntrySha256 = (Get-FileHash $entry -Algorithm SHA256).Hash.ToLowerInvariant()
    $proof.result = 'passed'
} catch { $failure = $_; $proof.error = $_.Exception.Message } finally {
    $cleanupErrors = @()
    try { Stop-ProofGateway } catch { $cleanupErrors += $_.Exception.Message }
    try {
        [Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
        if ([Environment]::GetEnvironmentVariable('Path', 'User') -cne $userPath) { throw 'User PATH restoration mismatch.' }
    } catch { $cleanupErrors += $_.Exception.Message }
    foreach ($name in $names) {
        try {
            if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
            if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $saved[$name]) { throw "$name restoration mismatch." }
        } catch { $cleanupErrors += $_.Exception.Message }
    }
    try { Remove-Item -LiteralPath $root -Recurse -Force; if (Test-Path -LiteralPath $root) { throw 'Owned proof root survived cleanup.' } } catch { $cleanupErrors += $_.Exception.Message }
    $proof.cleanup = if ($cleanupErrors.Count) { 'failed' } else { 'restored-and-removed' }
    $proof.cleanupErrors = $cleanupErrors
    if ($cleanupErrors.Count) { $proof.result = 'failed' }
    $proof | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $EvidenceRoot 'result.json')
}
if ($failure) { throw $failure }
if ($proof.result -ne 'passed') { throw 'Installer proof cleanup failed.' }
