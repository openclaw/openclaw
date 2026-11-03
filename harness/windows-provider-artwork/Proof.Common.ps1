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
