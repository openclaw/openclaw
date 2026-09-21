# Opt-in proof for a disposable GitHub-hosted Windows VM, never an operator machine.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidateRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
    [Parameter(Mandatory = $true)][ValidateSet('powershell', 'pwsh')][string]$ExpectedEngine,
    [Parameter(Mandatory = $true)][string]$EvidencePath
)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This proof changes temporary VM PATH state and requires a fresh GitHub-hosted Windows runner.'
}
$version = $PSVersionTable.PSVersion
if (($ExpectedEngine -eq 'powershell' -and ($version.Major -ne 5 -or $version.Minor -ne 1)) -or
    ($ExpectedEngine -eq 'pwsh' -and $version.Major -lt 7)) {
    throw 'Unexpected PowerShell engine.'
}
$head = (& git -C $CandidateRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedHead) { throw 'Candidate HEAD does not match the exact input.' }
$installer = Join-Path $CandidateRoot 'scripts/install.ps1'
$blob = (& git -C $CandidateRoot rev-parse 'HEAD:scripts/install.ps1').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve installer source blob.' }
$actualBlob = (& git -C $CandidateRoot hash-object -- $installer).Trim()
if ($LASTEXITCODE -ne 0 -or $blob -cne $actualBlob) { throw 'Installer differs from the published commit.' }
$EvidencePath = [IO.Path]::GetFullPath($EvidencePath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $EvidencePath) | Out-Null
$root = Join-Path $env:RUNNER_TEMP ('openclaw-portable-proof-' + [guid]::NewGuid().ToString('N'))
$names = @('Path', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'NODE_OPTIONS')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$enginePath = (Get-Process -Id $PID).Path
$proof = [ordered]@{
    result = 'failed'; head = $head; installerBlob = $blob
    installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    engine = $ExpectedEngine; engineVersion = $version.ToString(); enginePath = $enginePath
    engineSha256 = (Get-FileHash -LiteralPath $enginePath -Algorithm SHA256).Hash.ToLowerInvariant()
    checksumResponsibility = 'Proof observer independently verifies official SHASUMS; Install-PortableNode itself does not verify checksums.'
    packageManagers = 'Real cmd shims deliberately exit 17; download, extraction, runtime, SQLite and PATH owners are not mocked.'
    cleanup = 'pending'
}
$failure = $null
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $shim = Join-Path $root 'bin'
    $temp = Join-Path $root 'temp'
    $local = Join-Path $root 'local'
    New-Item -ItemType Directory -Path @($shim, $temp, $local) | Out-Null
    $script:ManagerCalls = Join-Path $root 'managers.txt'
    foreach ($manager in @('winget', 'choco', 'scoop')) {
        $cmd = "@echo off" + [Environment]::NewLine +
            ('echo ' + $manager + '>>"' + $script:ManagerCalls + '"') + [Environment]::NewLine +
            'exit /b 17' + [Environment]::NewLine
        [IO.File]::WriteAllText((Join-Path $shim ($manager + '.cmd')), $cmd, [Text.Encoding]::ASCII)
    }
    # Refresh-ProcessPath reads registry PATH; bound all three real scopes and restore them below.
    $isolatedPath = "$shim;$env:SystemRoot\System32;$env:SystemRoot;$PSHOME"
    [Environment]::SetEnvironmentVariable('Path', $isolatedPath, 'Machine')
    [Environment]::SetEnvironmentVariable('Path', $isolatedPath, 'User')
    $env:Path = $isolatedPath
    $env:LOCALAPPDATA = $local
    $env:TEMP = $temp
    $env:TMP = $temp
    foreach ($name in @('ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)')) {
        [Environment]::SetEnvironmentVariable($name, $root, 'Process')
    }
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process')
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -ne 0) { throw 'Candidate installer does not parse in this engine.' }
    # Load exact top-level owner functions without starting unrelated npm/onboarding installation.
    foreach ($statement in $ast.EndBlock.Statements) {
        if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
            . ([scriptblock]::Create($statement.Extent.Text))
        }
    }
    $budget = @($ast.EndBlock.Statements | Where-Object {
        $_ -is [Management.Automation.Language.AssignmentStatementAst] -and
        $_.Left.Extent.Text -eq '$script:UpdateNetworkTimeoutSeconds'
    })
    if ($budget.Count -ne 1) { throw 'Missing canonical download budget.' }
    . ([scriptblock]::Create($budget[0].Extent.Text))
    $script:InstallerTempDirectory = $temp
    if (Check-Node) { throw 'Fixture failed to remove the usable starting runtime.' }
    $script:RealSaveInstallerDownload = (Get-Command Save-InstallerDownload).ScriptBlock
    $script:ArchiveProof = @()
    function Save-InstallerDownload {
        param([string]$Uri, [string]$OutFile)
        & $script:RealSaveInstallerDownload -Uri $Uri -OutFile $OutFile
        if ($Uri -match '^https://nodejs\.org/dist/(?<version>v26\.\d+\.\d+)/(?<name>node-v26\.\d+\.\d+-win-(?:x64|arm64)\.zip)$') {
            $release = $Matches['version']; $name = $Matches['name']
            $sumPath = Join-Path $script:InstallerTempDirectory 'SHASUMS256.txt'
            & $script:RealSaveInstallerDownload -Uri "https://nodejs.org/dist/$release/SHASUMS256.txt" -OutFile $sumPath
            $pattern = '^(?<hash>[0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($name) + '$'
            $expected = @(Get-Content -LiteralPath $sumPath | ForEach-Object {
                if ($_ -match $pattern) { $Matches['hash'].ToLowerInvariant() }
            })
            $actual = (Get-FileHash -LiteralPath $OutFile -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($expected.Count -ne 1 -or $actual -cne $expected[0]) { throw 'Official ZIP checksum mismatch.' }
            $script:ArchiveProof += @{ url = $Uri; sha256 = $actual; bytes = (Get-Item -LiteralPath $OutFile).Length }
        } else { throw 'Portable recovery downloaded an unexpected artifact.' }
    }
    $result = @(Install-Node)
    if (-not (Test-BooleanSuccessResult -Results $result)) { throw 'Package-manager failure did not recover through portable Node.' }
    $calls = @(Get-Content -LiteralPath $script:ManagerCalls)
    if (($calls -join ',') -cne 'winget,choco,scoop') { throw 'Did not exercise all three failing package managers in order.' }
    if ($script:ArchiveProof.Count -ne 1) { throw 'Recovery did not download exactly one official ZIP.' }
    $nodeExe = Get-PortableNodeCommandPath
    if (-not $nodeExe -or -not (Check-Node -NodePath $nodeExe)) { throw 'Real runtime/SQLite validation failed.' }
    $resolvedNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    if ($resolvedNode -ine $nodeExe) { throw 'Process PATH did not select the installed portable runtime.' }
    $nodeDir = Split-Path -Parent $nodeExe
    if (-not (@([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') -icontains $nodeDir)) {
        throw 'Portable runtime is absent from real user PATH.'
    }
    $proof.managers = $calls
    $proof.archive = $script:ArchiveProof[0]
    $proof.nodeVersion = (& $nodeExe -v).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Installed runtime failed to start.' }
    $proof.nodeSha256 = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
    $proof.sqliteCapabilityProbe = 'Exact Check-Node passed version, NUL TEXT, BLOB and JSON probes on the downloaded runtime.'
    $proof.processPath = 'portable runtime selected'
    $proof.userPath = 'portable runtime present'
    $proof.result = 'passed'
} catch {
    $failure = $_
    $proof.error = $_.Exception.Message
} finally {
    $cleanupErrors = @()
    foreach ($scope in @('Machine', 'User')) {
        try {
            $value = if ($scope -eq 'Machine') { $machinePath } else { $userPath }
            [Environment]::SetEnvironmentVariable('Path', $value, $scope)
            if ([Environment]::GetEnvironmentVariable('Path', $scope) -cne $value) { throw "$scope PATH restoration mismatch." }
        } catch { $cleanupErrors += $_.Exception.Message }
    }
    foreach ($name in $names) {
        try {
            if ($null -eq $saved[$name]) {
                Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            } else {
                [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
            }
            if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $saved[$name]) { throw "$name restoration mismatch." }
        } catch { $cleanupErrors += $_.Exception.Message }
    }
    try {
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
        if (Test-Path -LiteralPath $root) { throw 'Owned portable proof root survived cleanup.' }
    } catch { $cleanupErrors += $_.Exception.Message }
    $proof.cleanup = if ($cleanupErrors.Count -eq 0) { 'restored-and-removed' } else { 'failed' }
    $proof.cleanupErrors = $cleanupErrors
    if ($cleanupErrors.Count -ne 0) { $proof.result = 'failed' }
    $proof | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
}
if ($failure) { throw $failure }
if ($proof.result -ne 'passed') { throw 'Portable proof cleanup failed.' }
