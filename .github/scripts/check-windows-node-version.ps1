#!/usr/bin/env pwsh
#requires -Version 7.0
<#
.SYNOPSIS
    Checks if OpenClaw release Windows Hub installers are up-to-date with openclaw-windows-node.

.DESCRIPTION
    Compares the Windows Hub installer version bundled in an OpenClaw release against
the latest available version from the openclaw-windows-node repository. Helps identify
version drift that may contain critical fixes (e.g., localized WSL version parsing).

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

# Configuration
$WindowsNodeRepo = "openclaw/openclaw-windows-node"
$OpenClawRepo = $env:GITHUB_REPOSITORY ?? "openclaw/openclaw"
$AssetName = "OpenClawCompanion-Setup-x64.exe"

function Write-Info {
    param([string]$Message)
    Write-Host "[check-windows-node] $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[check-windows-node] WARN: $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "[check-windows-node] ERROR: $Message" -ForegroundColor Red
}

function Get-VersionFromRelease {
    param(
        [string]$Repo,
        [string]$Tag,
        [switch]$FromAsset
    )

    $releaseInfo = $null

    if ($FromAsset) {
        # Get version from OpenClaw release asset SHA256SUMS file
        try {
            $releaseInfo = gh release view $Tag --repo $Repo --json assets 2>$null | ConvertFrom-Json
            if (-not $releaseInfo) {
                return $null
            }

            # Look for SHA256SUMS file which contains version info in comment
            $shaSumsAsset = $releaseInfo.assets | Where-Object { $_.name -eq "OpenClawCompanion-SHA256SUMS.txt" }
            if ($shaSumsAsset) {
                $content = gh api $shaSumsAsset.url 2>$null
                if ($content) {
                    # Check if there's a version comment in the file
                    $versionLine = $content -split "`n" | Where-Object { $_ -match "# Version:\s*(v?[\d.]+)" }
                    if ($versionLine) {
                        $matches = [regex]::Match($versionLine, "# Version:\s*(v?[\d.]+)")
                        if ($matches.Success) {
                            return $matches.Groups[1].Value.TrimStart('v')
                        }
                    }
                }
            }

            # Fallback: try to extract version from installer filename patterns in body
            $releaseBody = gh release view $Tag --repo $Repo --json body 2>$null | ConvertFrom-Json
            if ($releaseBody.body -match "openclaw-windows-node@(?:v?)([\d.]+)") {
                return $matches.Groups[1].Value
            }

            return $null
        }
        catch {
            return $null
        }
    }
    else {
        # Get version from windows-node release tag
        try {
            $releaseInfo = gh release view $Tag --repo $Repo --json tagName 2>$null | ConvertFrom-Json
            if ($releaseInfo -and $releaseInfo.tagName -match "v?([\d.]+)") {
                return $matches.Groups[1].Value
            }
            return $null
        }
        catch {
            return $null
        }
    }
}

function Get-VersionParts {
    param([string]$Version)

    $parts = $Version -split '\.'
    return @{
        Major = [int]($parts[0] ?? 0)
        Minor = [int]($parts[1] ?? 0)
        Patch = [int]($parts[2] ?? 0)
        Raw = $Version
    }
}

function Compare-Versions {
    param(
        [string]$Current,
        [string]$Latest
    )

    $currentParts = Get-VersionParts $Current
    $latestParts = Get-VersionParts $Latest

    $lag = 0

    if ($latestParts.Major -ne $currentParts.Major) {
        $lag = 1000  # Major version difference is significant
    }
    elseif ($latestParts.Minor -ne $currentParts.Minor) {
        $lag = 100   # Minor version difference is significant
    }
    else {
        $lag = $latestParts.Patch - $currentParts.Patch
    }

    return $lag
}

# Main execution
Write-Info "Checking Windows Hub version alignment..."
Write-Info "OpenClaw release: $ReleaseTag"
Write-Info "Windows node repo: $WindowsNodeRepo"

# Check if gh CLI is available
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "GitHub CLI (gh) is required but not available"
    exit 1
}

# Get latest windows-node version
Write-Info "Querying latest $WindowsNodeRepo version..."
$latestWindowsNodeVersion = Get-VersionFromRelease -Repo $WindowsNodeRepo -Tag "latest"

if (-not $latestWindowsNodeVersion) {
    Write-Error "Could not determine latest openclaw-windows-node version"
    exit 1
}

Write-Info "Latest openclaw-windows-node version: $latestWindowsNodeVersion"

# Get OpenClaw release windows-node version (if available)
Write-Info "Querying OpenClaw release '$ReleaseTag' for bundled windows-node version..."
$bundledVersion = Get-VersionFromRelease -Repo $OpenClawRepo -Tag $ReleaseTag -FromAsset

if ($bundledVersion) {
    Write-Info "OpenClaw release bundled windows-node version: $bundledVersion"

    $lag = Compare-Versions -Current $bundledVersion -Latest $latestWindowsNodeVersion

    if ($lag -eq 0) {
        Write-Info "SUCCESS: OpenClaw release is using the latest windows-node version"
        exit 0
    }
    elseif ($lag -lt 0) {
        Write-Warn "OpenClaw release ($bundledVersion) is AHEAD of latest windows-node ($latestWindowsNodeVersion)"
        exit 0
    }
    elseif ($lag -ge 100) {
        Write-Error "CRITICAL: Major/Minor version mismatch!"
        Write-Error "  OpenClaw bundled: $bundledVersion"
        Write-Error "  Latest available: $latestWindowsNodeVersion"
        Write-Error "  Remediation: Run windows-node-release workflow to promote latest installers"

        if ($FailOnLag) {
            exit 1
        }
        exit 0
    }
    elseif ($lag -gt $MaxPatchLag) {
        Write-Warn "Windows-node version lag detected: $lag patch versions behind"
        Write-Warn "  OpenClaw bundled: $bundledVersion"
        Write-Warn "  Latest available: $latestWindowsNodeVersion"
        Write-Warn "  Maximum allowed lag: $MaxPatchLag"
        Write-Warn "  Remediation: Run windows-node-release workflow with windows_node_tag=$latestWindowsNodeVersion"

        if ($FailOnLag) {
            exit 1
        }
        exit 0
    }
    else {
        Write-Info "Acceptable version lag: $lag patch versions (within threshold of $MaxPatchLag)"
        exit 0
    }
}
else {
    Write-Warn "Could not determine bundled windows-node version from OpenClaw release"
    Write-Warn "This may indicate:"
    Write-Warn "  - Release does not include Windows Hub installers yet"
    Write-Warn "  - Installers were not promoted via windows-node-release workflow"
    Write-Warn ""
    Write-Warn "Remediation:"
    Write-Warn "  Run windows-node-release workflow to promote windows-node $latestWindowsNodeVersion"
    Write-Warn "  to OpenClaw release $ReleaseTag"

    if ($FailOnLag) {
        exit 1
    }
    exit 0
}
