Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
function Save-Json($Value, [string]$Path) {
    ConvertTo-Json -InputObject $Value -Depth 16 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Resolve-ExistingDirectory([string]$Path) {
    $resolved = Resolve-Path -LiteralPath $Path
    if ($resolved.Provider.Name -cne 'FileSystem') { throw 'A filesystem directory is required.' }
    $item = Get-Item -LiteralPath $resolved.ProviderPath
    if (!$item.PSIsContainer) { throw 'An existing directory is required.' }
    $item.FullName
}
function Invoke-Git([string]$Source, [string[]]$Arguments) {
    $value = & git -C $Source @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Git query failed: $Source" }
    $value
}
function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $File" }
}
function Assert-Packet {
    $seals = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'packet-seals.json') -Raw | ConvertFrom-Json
    foreach ($file in $seals.files) {
        if ((Hash (Join-Path $PSScriptRoot $file.path)) -cne $file.sha256) { throw "Packet seal mismatch: $($file.path)" }
    }
    $actual = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse | ForEach-Object {
        [IO.Path]::GetRelativePath($PSScriptRoot,$_.FullName).Replace('\','/')
    })
    # The manifest itself is sealed by the review handoff, never recursively by itself.
    if ($actual.Count -ne $seals.files.Count + 1) { throw 'Unexpected packet file inventory.' }
}
function Assert-Base([string]$Source) {
    if ((Invoke-Git $Source @('rev-parse','HEAD')).Trim() -cne 'd38ebb418c3aba6b24a4d6470def72b2bba4c4a8') { throw 'Unexpected source base.' }
    if (@(Invoke-Git $Source @('status','--porcelain')).Count -ne 0) { throw 'Fresh source checkout required.' }
}
function Source-Manifest([string]$Source) {
    @(Invoke-Git $Source @('-c','core.quotepath=false','ls-files','--cached','--others','--exclude-standard') |
        Sort-Object -Unique | ForEach-Object { @{path=$_;sha256=(Hash (Join-Path $Source $_))} })
}
function Assert-Files([string]$Base, $Entries, [string]$Prefix = '') {
    foreach ($entry in $Entries) {
        $relative = if ($Prefix) { $entry.path.Substring($Prefix.Length) } else { $entry.path }
        if ((Hash (Join-Path $Base $relative)) -cne $entry.sha256.ToLowerInvariant()) { throw "Frozen file changed: $relative" }
    }
}
function Assert-Product([string]$Source, [switch]$WithComparison) {
    $evidence = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'composed-evidence.json') -Raw | ConvertFrom-Json
    if ((Hash (Join-Path $PSScriptRoot 'ollama-windows-composed.patch')) -cne $evidence.patch.sha256) { throw 'Reviewed patch differs.' }
    if ((Invoke-Git $Source @('rev-parse','HEAD')).Trim() -cne $evidence.base) { throw 'Product base differs.' }
    $overlays = Get-Content (Join-Path $PSScriptRoot 'TEST-OVERLAYS.json') -Raw | ConvertFrom-Json
    foreach ($file in $evidence.files) {
        $expectedHash = $file.sha256
        if ($WithComparison) {
            $testOverlay = @($overlays.afterOnly | Where-Object {$_.path -ceq $file.path})
            if ($testOverlay.Count -eq 1) { $expectedHash = $testOverlay[0].sha256 }
        }
        if ((Hash (Join-Path $Source $file.path)) -cne $expectedHash) { throw "Product/test postimage differs: $($file.path)" }
    }
    & git -C $Source diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Proof must not stage product changes.' }
    $expected = @($evidence.files.path)
    if ($WithComparison) {
        foreach ($overlay in @($overlays.common) + @($overlays.afterOnly)) {
            if ((Hash (Join-Path $Source $overlay.path)) -cne $overlay.sha256) { throw "Test-only overlay differs: $($overlay.path)" }
            $expected += $overlay.path
        }
    }
    $actual = @(@(Invoke-Git $Source @('diff','--name-only','HEAD')) + @(Invoke-Git $Source @('ls-files','--others','--exclude-standard')) | Sort-Object -Unique)
    if (@(Compare-Object ($expected | Sort-Object -Unique) $actual).Count -ne 0) { throw 'Unreviewed source delta.' }
}
function Assert-StrictTrx([string]$Path, [int]$Expected, [datetime]$StartedUtc) {
    . (Join-Path $env:OPENCLAW_REPO_ROOT 'scripts/TestResultContract.ps1')
    $contract = Read-TestResultContract -Path $Path -StartedUtc $StartedUtc -ExitCode 0
    [xml]$trx = Get-Content -LiteralPath $Path -Raw
    $cases = @($trx.SelectNodes("//*[local-name()='UnitTestResult']"))
    $counter = $trx.SelectSingleNode("//*[local-name()='Counters']")
    if ($cases.Count -ne $Expected -or [int]$counter.executed -ne $Expected -or [int]$counter.passed -ne $Expected -or
        @($cases | Where-Object {$_.outcome -cne 'Passed'}).Count -ne 0) { throw "Strict case inventory differs: $Path" }
    Save-Json @{expected=$Expected;executed=$cases.Count;passed=$cases.Count;skipped=0;caseNames=@($cases.testName);contract=$contract} ($Path + '.contract.json')
}
