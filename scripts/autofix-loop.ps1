# OpenClaw PR Autofix — Windows launcher
#
# Invoked by the scheduled task registered via
# `scripts/autofix-install-windows-task.ps1`. Runs once and exits. The
# scheduler handles the "every N minutes" cadence.
#
# Responsibilities:
#   * Set working directory to the OpenClaw repo root so `autofix.py`
#     can find `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`.
#   * Pull GITHUB_TOKEN from the user's env (do NOT store in this file).
#   * Append a timestamped log line to the rolling log file.
#   * Skip gracefully if another instance is already running (ignoring
#     lock timeouts prevents the cron from stacking runs).
#
# Environment variables consumed:
#   GITHUB_TOKEN            required; set once via
#                           `setx GITHUB_TOKEN "<your PAT>"` in cmd
#   AUTOFIX_TARGET_REPO     default: openclaw/openclaw
#   AUTOFIX_TARGET_PR       default: 68135
#   AUTOFIX_AUTH_MODE       default: subscription (uses `claude login`)
#   AUTOFIX_MODEL           default: claude-sonnet-4-5-20250929

param(
    [string]$Repo = $env:AUTOFIX_TARGET_REPO,
    [int]$PrNumber = [int]$env:AUTOFIX_TARGET_PR,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Defaults if env vars weren't set.
if (-not $Repo)     { $Repo = "openclaw/openclaw" }
if (-not $PrNumber) { $PrNumber = 68135 }

# Derive the repo root from this script's location rather than a
# hardcoded path, so the launcher works for any checkout location
# (CI workspaces, fork clones not at C:\OpenClaw, etc.). This script
# lives at <repo>\scripts\autofix-loop.ps1; $PSScriptRoot is scripts/
# and the repo root is its parent.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $env:USERPROFILE ".openclaw\autofix"
$LockFile = Join-Path $LogDir "autofix.lock"

# Resolve today's log file.
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$Today = Get-Date -Format "yyyy-MM-dd"
$LogFile = Join-Path $LogDir "autofix-$Today.log"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Line = "$Stamp [$Level] $Message"
    Add-Content -Path $LogFile -Value $Line -Encoding utf8
    # Also echo to stdout so `Get-ScheduledTaskInfo` / interactive runs see it.
    Write-Host $Line
}

# Bail early if another instance is running. We use a simple file lock:
# if the .lock file exists and was touched within the last hour, skip.
# Stale locks (older than 1h, which implies crash) are cleaned up.
if (Test-Path $LockFile) {
    $LockAge = (Get-Date) - (Get-Item $LockFile).LastWriteTime
    if ($LockAge.TotalMinutes -lt 60) {
        Write-Log "Skip: lock file present ($([int]$LockAge.TotalMinutes) min old)" "WARN"
        exit 0
    }
    Write-Log "Stale lock detected; removing" "WARN"
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}

try {
    # Acquire lock.
    Set-Content -Path $LockFile -Value $PID -Encoding ascii -Force

    # Validate env.
    if (-not $env:GITHUB_TOKEN) {
        Write-Log "GITHUB_TOKEN not set in user environment - cannot run" "ERROR"
        Write-Log 'Fix: run `setx GITHUB_TOKEN "<your PAT>"` in cmd and restart the task' "ERROR"
        exit 1
    }

    Set-Location $RepoRoot
    # Pre-build the log message as a variable and pass via named param.
    # A previous run produced a malformed first log line that bound
    # "repo=openclaw/openclaw" to -Level instead of "INFO" -- the
    # symptom of PowerShell splitting a single quoted arg into multiple
    # positional args. Explicit -Message removes the ambiguity.
    $StartMsg = "Starting autofix run. repo=$Repo pr=#$PrNumber dry=$DryRun"
    Write-Log -Message $StartMsg

    # Preserve the user's claude login session. The task runs as the
    # logged-in user, so ~/.claude/ is already accessible; no env
    # override needed. `-u` disables Python's output buffering so stdout
    # lines land in the log as they're written, not only on exit.
    $Args = @(
        "-u",
        "autofix.py",
        "--repo", $Repo,
        "--pr", $PrNumber
    )
    if ($DryRun) { $Args += "--dry-run" }

    # Spawn python and capture both streams to the log. Wrap each arg
    # in literal double-quotes so paths with spaces stay intact.
    $ProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
    $ProcessInfo.FileName = "python"
    $QuotedArgs = $Args | ForEach-Object { '"' + $_ + '"' }
    $ProcessInfo.Arguments = ($QuotedArgs -join " ")
    $ProcessInfo.WorkingDirectory = $RepoRoot
    $ProcessInfo.RedirectStandardOutput = $true
    $ProcessInfo.RedirectStandardError = $true
    $ProcessInfo.UseShellExecute = $false
    $ProcessInfo.CreateNoWindow = $true

    # Stream stdout line-by-line so Python's output lands in the log as
    # it's produced, not buffered until exit. stderr is drained after
    # the process finishes -- autofix.py's stderr is minimal (error
    # tracebacks only), well under the pipe buffer, so no deadlock risk.
    $Process = [System.Diagnostics.Process]::Start($ProcessInfo)

    while (-not $Process.StandardOutput.EndOfStream) {
        $line = $Process.StandardOutput.ReadLine()
        if ($line) { Write-Log "  $line" "OUT" }
    }

    $Process.WaitForExit()
    $ExitCode = $Process.ExitCode

    $StdErr = $Process.StandardError.ReadToEnd()
    if ($StdErr) {
        foreach ($line in $StdErr -split '\r?\n') {
            if ($line) { Write-Log "  $line" "ERR" }
        }
    }

    if ($ExitCode -ne 0) {
        Write-Log "autofix.py exited non-zero: $ExitCode" "ERROR"
        exit $ExitCode
    }
    Write-Log "autofix run complete"
    exit 0
}
catch {
    Write-Log "Launcher caught exception: $_" "ERROR"
    exit 1
}
finally {
    # Always release the lock even on failure.
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}
