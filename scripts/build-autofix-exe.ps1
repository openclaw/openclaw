# Build the OpenClaw PR Autofix daemon as a standalone Windows .exe.
#
# Output: dist\openclaw-autofix.exe (single-file, no console window)
#
# Usage:
#   cd C:\OpenClaw
#   .\scripts\build-autofix-exe.ps1
#
# Requires: Python 3.10+ on PATH. Installs PyInstaller on first run.

param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$DaemonScript = Join-Path $RepoRoot "scripts\autofix_daemon.py"
$DistDir = Join-Path $RepoRoot "dist"
$BuildDir = Join-Path $RepoRoot "build"
$SpecFile = Join-Path $RepoRoot "openclaw-autofix.spec"

if (-not (Test-Path $DaemonScript)) {
    Write-Error "Daemon source not found at $DaemonScript"
    exit 1
}

# Ensure Python is available.
$pyExe = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $pyExe) {
    Write-Error "python not found on PATH. Install Python 3.10+ from https://www.python.org/downloads/."
    exit 1
}
Write-Host "Using Python at $pyExe"

# Ensure PyInstaller is installed. Use `python -m pip show` instead of
# `python -m PyInstaller --version` so the check doesn't write a
# ModuleNotFoundError to stderr -- which, combined with
# $ErrorActionPreference = "Stop", would crash the script before the
# install step runs.
$ErrorActionPreference = "Continue"
$piShow = & $pyExe -m pip show pyinstaller 2>&1
$ErrorActionPreference = "Stop"
if ($LASTEXITCODE -ne 0 -or -not ($piShow -match "^Name:")) {
    Write-Host "PyInstaller not found; installing via pip..."
    & $pyExe -m pip install --user pyinstaller
    if ($LASTEXITCODE -ne 0) {
        Write-Error "PyInstaller install failed."
        exit 1
    }
}

# Optional clean to avoid stale builds biting us.
if ($Clean) {
    foreach ($p in @($DistDir, $BuildDir, $SpecFile)) {
        if (Test-Path $p) {
            Write-Host "Removing $p"
            Remove-Item -Recurse -Force -Path $p
        }
    }
}

Push-Location $RepoRoot
try {
    Write-Host "Building openclaw-autofix.exe..."
    # --onefile   single self-contained .exe
    # --noconsole hide the console window (runs invisibly)
    # --name      fix the output filename regardless of script name
    # --distpath  pin output to repo-relative dist/
    # --workpath  pin intermediate build to repo-relative build/
    & $pyExe -m PyInstaller `
        --onefile `
        --noconsole `
        --name openclaw-autofix `
        --distpath $DistDir `
        --workpath $BuildDir `
        --specpath $RepoRoot `
        $DaemonScript
    if ($LASTEXITCODE -ne 0) {
        Write-Error "PyInstaller build failed with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

$ExePath = Join-Path $DistDir "openclaw-autofix.exe"
if (-not (Test-Path $ExePath)) {
    Write-Error "Build reported success but $ExePath is missing."
    exit 1
}

$ExeSize = [math]::Round((Get-Item $ExePath).Length / 1MB, 1)

Write-Host ""
Write-Host "[OK] Built openclaw-autofix.exe ($ExeSize MB)"
Write-Host "     $ExePath"
Write-Host ""
Write-Host "To run in the background:"
Write-Host "  Start-Process '$ExePath'"
Write-Host ""
Write-Host "Or double-click the .exe in Explorer. It runs hidden with no console."
Write-Host ""
Write-Host "To auto-start at login, put a shortcut to the .exe in your Startup folder:"
Write-Host "  explorer shell:startup"
Write-Host "  (drag the .exe into that folder while holding Alt to create a shortcut)"
Write-Host ""
Write-Host "To stop the daemon:"
Write-Host "  Get-Content ""`$env:USERPROFILE\.openclaw\autofix\daemon.pid"" | ForEach-Object { Stop-Process -Id `$_ -Force }"
Write-Host "  (or Task Manager -> find openclaw-autofix.exe -> End task)"
