# Rollback Procedures — OpenClaw Windows

## MSIX Rollback

MSIX packages are versioned and multiple versions can coexist. To roll back:

### Step 1: Stop the application

```powershell
# Stop OpenClaw Windows if running
Get-Process -Name "OpenClawWindows" -ErrorAction SilentlyContinue | Stop-Process -Force
```

### Step 2: Install the previous MSIX

```powershell
# Download previous MSIX from GitHub Releases (find the previous tag)
# Then install over the current version
Add-AppxPackage -ForceApplicationShutdown OpenClawWindows_x64_PREVIOUS.msix
```

### Step 3: Verify rollback

```powershell
# Confirm the installed version
Get-AppxPackage -Name "ai.openclaw.windows" | Select-Object Name, Version
```

The tray icon should reappear. Check **Settings → About** for the version number.

## Settings Rollback

Settings are persisted to `%APPDATA%\OpenClaw\settings.json`. To revert:

```powershell
# Backup current settings
Copy-Item "$env:APPDATA\OpenClaw\settings.json" "$env:APPDATA\OpenClaw\settings.json.bak"

# Restore from backup (if you made one before the upgrade)
Copy-Item "$env:APPDATA\OpenClaw\settings.json.bak" "$env:APPDATA\OpenClaw\settings.json"
```

## Full Uninstall

```powershell
# Remove the package
Get-AppxPackage -Name "ai.openclaw.windows" | Remove-AppxPackage

# Remove app data (optional — preserves logs for diagnostics)
Remove-Item "$env:APPDATA\OpenClaw" -Recurse -Force
```

## Git-Based Rollback (for contributors)

```powershell
# List recent tags
git tag --sort=-version:refname | Select-Object -First 10

# Check out a previous release to rebuild from source
git checkout v1.0.0
cd openclaw/apps/windows
dotnet build -c Release
```

## Verification After Rollback

```powershell
# 1. Confirm the app is running
Get-Process OpenClawWindows

# 2. Check tray icon is visible and shows correct version

# 3. Test gateway connection: right-click tray → should show green status

# 4. Run tests against the rolled-back build
dotnet test tests/OpenClawWindows.Tests.csproj
```

## Post-Rollback Actions

1. Document the rollback in the GitHub issue / incident log
2. Identify the root cause before re-releasing
3. Fix and verify locally, then push a new tagged release
