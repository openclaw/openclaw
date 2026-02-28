# Nuclear Purge v3 — Drive-wide macOS Decontamination
# Run this from d:\Rykiri

Write-Host "=== DRIVE-WIDE NUCLEAR PURGE ===" -ForegroundColor Red
Write-Host "Removing macOS/iOS platform contamination across all projects...`n" -ForegroundColor Cyan

$projects = @("d:\Rykiri", "d:\Vorteke", "d:\AETERNA", "d:\neo-bank-", "d:\Titan consulting")
# $userHome = "C:\Users\craig"

$removed = 0
$skipped = 0

# 1. Targeted File Removal
Write-Host "Cleaning targeted project files..." -ForegroundColor Cyan
$targets = @(
    # Rykiri core dummy scripts
    "d:\Rykiri\scripts\build-and-run-mac.sh",
    "d:\Rykiri\scripts\codesign-mac-app.sh",
    "d:\Rykiri\scripts\create-dmg.sh",
    "d:\Rykiri\scripts\ios-configure-signing.sh",
    "d:\Rykiri\scripts\ios-team-id.sh",
    "d:\Rykiri\scripts\mobile-reauth.sh",
    "d:\Rykiri\scripts\notarize-mac-artifact.sh",
    "d:\Rykiri\scripts\package-mac-app.sh",
    "d:\Rykiri\scripts\package-mac-dist.sh",
    "d:\Rykiri\scripts\restart-mac.sh",
    "d:\Rykiri\scripts\dev\ios-node-e2e.ts",
    "d:\Rykiri\scripts\dev\ios-pull-gateway-log.sh",
    "d:\Rykiri\ui\src\ui\views\channels.imessage.ts",

    # Docs
    "d:\Rykiri\docs\platforms\macos.md",
    "d:\Rykiri\docs\platforms\ios.md",
    "d:\Rykiri\docs\platforms\mac"
)

foreach ($target in $targets) {
    if (Test-Path $target) {
        Remove-Item -Path $target -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  [REMOVED] $target" -ForegroundColor Yellow
        $removed++
    } else { $skipped++ }
}

# 2. Recursive System File Purge (.DS_Store, __MACOSX, .podspec, .xcodeproj, .xcworkspace, Podfile)
Write-Host "`nScanning and purging macOS artifacts (.DS_Store, XCode, etc)..." -ForegroundColor Cyan
$scanPaths = $projects + $userHome
foreach ($path in $scanPaths) {
    if (Test-Path $path) {
        Write-Host "  Scanning $path ..." -ForegroundColor Gray
        Get-ChildItem -Path $path -Include .DS_Store, __MACOSX, "*.podspec", "*.xcodeproj", "*.xcworkspace", "Podfile" -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
            $itemPath = $_.FullName
            Remove-Item -Path $itemPath -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "  [REMOVED] $itemPath" -ForegroundColor Yellow
            $removed++
        }
    }
}

# 3. Clear Temp sandbox markers
Write-Host "`nClearing Temp sandbox markers..." -ForegroundColor Cyan
Get-ChildItem -Path $env:TEMP -Filter "antigravity*.sb" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Force
    Write-Host "  [REMOVED] $($_.FullName)" -ForegroundColor Yellow
    $removed++
}

Write-Host "`n=== PURGE COMPLETE ===" -ForegroundColor Green
Write-Host "Removed: $removed items | Already clean: $skipped items" -ForegroundColor Green
Write-Host "`nCRITICAL: Restart the IDE/Assistant now to flush the platform cache." -ForegroundColor Red
