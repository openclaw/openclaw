# write-obsidian.ps1 — Safe Obsidian vault writer
# Usage: .\write-obsidian.ps1 -RelPath "00.DAILY/2026-03-08_Report.md" -Content "# Title..."
# Handles: directory creation, UTF-8 encoding, absolute path resolution
param(
    [Parameter(Mandatory=$true)]
    [string]$RelPath,

    [Parameter(Mandatory=$true)]
    [string]$Content
)

$vaultRoot = "C:\Users\jini9\OneDrive\Documents\JINI_SYNC"
$fullPath = Join-Path $vaultRoot $RelPath

# Ensure parent directory exists
$dir = Split-Path $fullPath
if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# Write with UTF-8 (no BOM)
[System.IO.File]::WriteAllText($fullPath, $Content, [System.Text.UTF8Encoding]::new($false))
Write-Output "OK: $fullPath"
