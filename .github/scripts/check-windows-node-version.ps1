#!/usr/bin/env pwsh
#requires -Version 5.1
<#
.SYNOPSIS
    Checks if OpenClaw release Windows Hub installers are up-to-date with openclaw-windows-node.

.DESCRIPTION
    Compares the Windows Hub installer version promoted on an OpenClaw release against
    the latest openclaw-windows-node release. Uses the promoted x64 installer digest as
    the authoritative bundled-version signal when available, and falls back to the
    release-body "Windows Hub source release" marker.

.PARAMETER ReleaseTag
    The OpenClaw release tag to check (e.g., "v2026.6.1"). Defaults to "latest".

.PARAMETER MaxPatchLag
    Maximum acceptable patch version difference. Defaults to 2.

.PARAMETER FailOnLag
    If set, exit with error code when version lag exceeds threshold.

.EXAMPLE
    .github/scripts/check-windows-node-version.ps1 -ReleaseTag "v2026.6.1"

.EXAMPLE
    .github/scripts/check-windows-node-version.ps1 -FailOnLag -MaxPatchLag 1
#>
[CmdletBinding()]
param(
    [string]$ReleaseTag = "latest",
    [int]$MaxPatchLag = 2,
    [switch]$FailOnLag
)

$ErrorActionPreference = "Stop"

$WindowsNodeRepo = "openclaw/openclaw-windows-node"
$OpenClawRepo = if ($env:GITHUB_REPOSITORY) { $env:GITHUB_REPOSITORY } else { "openclaw/openclaw" }

function Write-Info {
    param([string]$Message)
    Write-Host "[check-windows-node] $Message" -ForegroundColor Cyan
}

function Write-WarnLine {
    param([string]$Message)
    Write-Host "[check-windows-node] WARN: $Message" -ForegroundColor Yellow
}

function Write-ErrorLine {
    param([string]$Message)
    Write-Host "[check-windows-node] ERROR: $Message" -ForegroundColor Red
}

function Normalize-Version {
    param([string]$Version)
    return ($Version.Trim().TrimStart("v"))
}

function Get-ReleaseJson {
    param(
        [string]$Repo,
        [string]$Tag,
        [string[]]$Fields
    )

    $fieldList = ($Fields -join ",")
    if ($Tag -eq "latest") {
        return gh release view --repo $Repo --json $fieldList 2>$null | ConvertFrom-Json
    }

    return gh release view $Tag --repo $Repo --json $fieldList 2>$null | ConvertFrom-Json
}

function Get-VersionFromTagName {
    param([string]$TagName)

    if ($TagName -match "v?([\d.]+)") {
        return Normalize-Version $Matches[1]
    }

    return $null
}

function Get-LatestWindowsNodeVersion {
    $release = Get-ReleaseJson -Repo $WindowsNodeRepo -Tag "latest" -Fields @("tagName")
    if (-not $release) {
        return $null
    }

    return Get-VersionFromTagName $release.tagName
}

function Get-OpenClawReleaseTag {
    param([string]$Tag)

    if ($Tag -ne "latest") {
        return $Tag
    }

    $release = Get-ReleaseJson -Repo $OpenClawRepo -Tag "latest" -Fields @("tagName")
    if (-not $release) {
        return $null
    }

    return $release.tagName
}

function Get-ReleaseBody {
    param(
        [string]$Repo,
        [string]$Tag
    )

    $release = Get-ReleaseJson -Repo $Repo -Tag $Tag -Fields @("body")
    return $release.body
}

function Get-Sha256ManifestContent {
    param(
        [string]$Repo,
        [string]$Tag
    )

    $tempDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("openclaw-sha256-" + [Guid]::NewGuid().ToString("n")))
    try {
        gh release download $Tag --repo $Repo --pattern "OpenClawCompanion-SHA256SUMS.txt" --dir $tempDir.FullName | Out-Null
        $manifestPath = Join-Path $tempDir.FullName "OpenClawCompanion-SHA256SUMS.txt"
        if (-not (Test-Path -LiteralPath $manifestPath)) {
            return $null
        }

        return Get-Content -LiteralPath $manifestPath -Raw
    }
    finally {
        Remove-Item -LiteralPath $tempDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Get-X64HashFromManifest {
    param([string]$Content)

    if ($Content -match "(?m)^([a-f0-9]{64})\s+OpenClawCompanion-Setup-x64\.exe\s*$") {
        return $Matches[1].ToLowerInvariant()
    }

    return $null
}

function Get-X64HashFromReleaseBody {
    param([string]$Body)

    if ($Body -match "Windows Hub x64 SHA-256:\s*`?([a-f0-9]{64})`?") {
        return $Matches[1].ToLowerInvariant()
    }

    return $null
}

function Get-BodyDeclaredVersion {
    param([string]$Body)

    if ($Body -match "Windows Hub source release:\s*https://github\.com/openclaw/openclaw-windows-node/releases/tag/v?([\d.]+)") {
        return Normalize-Version $Matches[1]
    }

    if ($Body -match "openclaw-windows-node@(?:v?)([\d.]+)") {
        return Normalize-Version $Matches[1]
    }

    return $null
}

function Get-VersionCommentFromManifest {
    param([string]$Content)

    if ($Content -match "#\s*Version:\s*(v?[\d.]+)") {
        return Normalize-Version $Matches[1]
    }

    return $null
}

function Get-WindowsNodeVersionForX64Digest {
    param([string]$Digest)

    $releases = gh release list --repo $WindowsNodeRepo --limit 20 --json tagName | ConvertFrom-Json
    foreach ($release in $releases) {
        $tag = $release.tagName
        $assets = gh release view $tag --repo $WindowsNodeRepo --json assets | ConvertFrom-Json
        $x64Asset = $assets.assets | Where-Object { $_.name -eq "OpenClawCompanion-Setup-x64.exe" } | Select-Object -First 1
        if (-not $x64Asset) {
            continue
        }

        $assetDigest = ($x64Asset.digest -replace "^sha256:", "").ToLowerInvariant()
        if ($assetDigest -eq $Digest) {
            return Get-VersionFromTagName $tag
        }
    }

    return $null
}

function Get-VersionParts {
    param([string]$Version)

    $parts = (Normalize-Version $Version) -split '\.'
    return @{
        Major = [int]($(if ($parts[0]) { $parts[0] } else { 0 }))
        Minor = [int]($(if ($parts[1]) { $parts[1] } else { 0 }))
        Patch = [int]($(if ($parts[2]) { $parts[2] } else { 0 }))
        Raw = (Normalize-Version $Version)
    }
}

function Compare-Versions {
    param(
        [string]$Current,
        [string]$Latest
    )

    $currentParts = Get-VersionParts $Current
    $latestParts = Get-VersionParts $Latest

    if ($latestParts.Major -ne $currentParts.Major) {
        return 1000
    }
    if ($latestParts.Minor -ne $currentParts.Minor) {
        return 100
    }

    return $latestParts.Patch - $currentParts.Patch
}

function Resolve-BundledWindowsNodeVersion {
    param(
        [string]$ReleaseBody,
        [string]$Sha256Manifest
    )

    $bodyDeclaredVersion = Get-BodyDeclaredVersion $ReleaseBody
    $x64Hash = Get-X64HashFromManifest $Sha256Manifest
    if (-not $x64Hash) {
        $x64Hash = Get-X64HashFromReleaseBody $ReleaseBody
    }

    $digestInferredVersion = $null
    if ($x64Hash) {
        Write-Info "Resolved promoted x64 digest: $x64Hash"
        $digestInferredVersion = Get-WindowsNodeVersionForX64Digest -Digest $x64Hash
    }

    if ($digestInferredVersion) {
        return @{
            Version = $digestInferredVersion
            Source = "digest"
            BodyDeclaredVersion = $bodyDeclaredVersion
            DigestInferredVersion = $digestInferredVersion
            X64Hash = $x64Hash
            MetadataDrift = ($bodyDeclaredVersion -and ($bodyDeclaredVersion -ne $digestInferredVersion))
        }
    }

    if ($bodyDeclaredVersion) {
        return @{
            Version = $bodyDeclaredVersion
            Source = "release-body"
            BodyDeclaredVersion = $bodyDeclaredVersion
            DigestInferredVersion = $null
            X64Hash = $x64Hash
            MetadataDrift = $false
        }
    }

    $manifestCommentVersion = Get-VersionCommentFromManifest $Sha256Manifest
    if ($manifestCommentVersion) {
        return @{
            Version = $manifestCommentVersion
            Source = "manifest-comment"
            BodyDeclaredVersion = $null
            DigestInferredVersion = $null
            X64Hash = $x64Hash
            MetadataDrift = $false
        }
    }

    return @{
        Version = $null
        Source = $null
        BodyDeclaredVersion = $bodyDeclaredVersion
        DigestInferredVersion = $null
        X64Hash = $x64Hash
        MetadataDrift = $false
    }
}

Write-Info "Checking Windows Hub version alignment..."
Write-Info "OpenClaw release input: $ReleaseTag"
Write-Info "Windows node repo: $WindowsNodeRepo"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-ErrorLine "GitHub CLI (gh) is required but not available"
    exit 1
}

$openClawReleaseTag = Get-OpenClawReleaseTag -Tag $ReleaseTag
if (-not $openClawReleaseTag) {
    Write-ErrorLine "Could not resolve OpenClaw release tag from input '$ReleaseTag'"
    exit 1
}

Write-Info "Resolved OpenClaw release tag: $openClawReleaseTag"

$latestWindowsNodeVersion = Get-LatestWindowsNodeVersion
if (-not $latestWindowsNodeVersion) {
    Write-ErrorLine "Could not determine latest openclaw-windows-node version"
    exit 1
}

Write-Info "Latest openclaw-windows-node version: $latestWindowsNodeVersion"

$releaseBody = Get-ReleaseBody -Repo $OpenClawRepo -Tag $openClawReleaseTag
$sha256Manifest = Get-Sha256ManifestContent -Repo $OpenClawRepo -Tag $openClawReleaseTag
$manifestContent = if ($sha256Manifest) { $sha256Manifest } else { "" }
$resolved = Resolve-BundledWindowsNodeVersion -ReleaseBody $releaseBody -Sha256Manifest $manifestContent

if ($resolved.MetadataDrift) {
    Write-WarnLine "Release metadata drift detected"
    Write-WarnLine "  Release body declares: $($resolved.BodyDeclaredVersion)"
    Write-WarnLine "  Promoted x64 digest maps to: $($resolved.DigestInferredVersion)"
}

if (-not $resolved.Version) {
    Write-WarnLine "Could not determine bundled windows-node version from OpenClaw release $openClawReleaseTag"
    Write-WarnLine "Remediation: run windows-node-release workflow to promote windows-node $latestWindowsNodeVersion"

    if ($FailOnLag) {
        exit 1
    }
    exit 0
}

Write-Info "Bundled windows-node version: $($resolved.Version) (source: $($resolved.Source))"

$lag = Compare-Versions -Current $resolved.Version -Latest $latestWindowsNodeVersion

if ($lag -eq 0) {
    Write-Info "SUCCESS: OpenClaw release is using the latest windows-node version"
    exit 0
}

if ($lag -lt 0) {
    Write-WarnLine "OpenClaw release ($($resolved.Version)) is ahead of latest windows-node ($latestWindowsNodeVersion)"
    exit 0
}

if ($lag -ge 100) {
    Write-ErrorLine "CRITICAL: Major/minor version mismatch"
    Write-ErrorLine "  OpenClaw bundled: $($resolved.Version)"
    Write-ErrorLine "  Latest available: $latestWindowsNodeVersion"
    Write-ErrorLine "  Remediation: run windows-node-release workflow to promote latest installers"

    if ($FailOnLag) {
        exit 1
    }
    exit 0
}

if ($lag -gt $MaxPatchLag) {
    Write-WarnLine "Windows-node version lag detected: $lag patch versions behind"
    Write-WarnLine "  OpenClaw bundled: $($resolved.Version)"
    Write-WarnLine "  Latest available: $latestWindowsNodeVersion"
    Write-WarnLine "  Maximum allowed lag: $MaxPatchLag"
    Write-WarnLine "  Remediation: run windows-node-release workflow with windows_node_tag=$latestWindowsNodeVersion"

    if ($FailOnLag) {
        exit 1
    }
    exit 0
}

Write-Info "Acceptable version lag: $lag patch versions (within threshold of $MaxPatchLag)"
exit 0
