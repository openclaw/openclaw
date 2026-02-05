$ErrorActionPreference = "Stop"
$LogFile = "$env:TEMP\moltbot-update-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

function Log {
    param([string]$msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

Log "[Moltbot] Stable Updater starting"
Log "Log file: $LogFile"

# Refresh PATH for scheduled task context (npm/node may not be in default PATH)
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

# Ensure we are in the right directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

# === Phase 1: Update ===
Log "--- Phase 1: Update ---"
try {
    # Ensure npm is resolvable (nvm4w uses .cmd shims)
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCmd) {
        $npmDir = Split-Path $npmCmd.Source
        if ($env:Path -notmatch [regex]::Escape($npmDir)) {
            $env:Path = "$npmDir;$env:Path"
        }
    }
    $updateOut = node moltbot.mjs update --channel stable --yes --no-restart 2>&1 | Out-String
    Add-Content -Path $LogFile -Value $updateOut
    Write-Host $updateOut
    if ($LASTEXITCODE -eq 0) {
        Log "[OK] Update complete."
    } else {
        Log "[WARN] Update exited with code $LASTEXITCODE"
    }
} catch {
    Log "[FAIL] Update failed: $_"
}

# === Phase 2: Doctor ===
Log "--- Phase 2: Doctor ---"
try {
    $doctorOut = node moltbot.mjs doctor 2>&1 | Out-String
    Add-Content -Path $LogFile -Value $doctorOut

    if ($doctorOut -match "(ERROR|FAIL|CRITICAL)") {
        Log "[WARN] Doctor found issues -- check log for details."
    } else {
        Log "[OK] Doctor check passed."
    }
} catch {
    Log "[WARN] Doctor command failed: $_"
}

# === Phase 3: Gateway Security Check ===
Log "--- Phase 3: Gateway Security ---"
try {
    $configPath = Join-Path $env:USERPROFILE ".moltbot\moltbot.json"
    $configRaw = Get-Content $configPath -Raw | ConvertFrom-Json
    $gw = $configRaw.gateway
    $issues = @()

    # Check bind address
    if ($gw.bind -eq "0.0.0.0" -or $gw.bind -eq "all") {
        $issues += "WARN: Gateway bound to all interfaces ($($gw.bind)) -- consider loopback"
    } else {
        Log "  bind=$($gw.bind) [OK]"
    }

    # Check auth mode
    if (-not $gw.auth -or $gw.auth.mode -eq "none") {
        $issues += "CRITICAL: Gateway auth is disabled -- set auth.mode to token"
    } else {
        Log "  auth.mode=$($gw.auth.mode) [OK]"
    }

    # Check token strength (16+ chars recommended)
    if ($gw.auth.token -and $gw.auth.token.Length -lt 16) {
        $issues += "WARN: Gateway auth token is short ($($gw.auth.token.Length) chars) -- use 16+ chars"
    } elseif ($gw.auth.token) {
        Log "  auth.token=set ($($gw.auth.token.Length) chars) [OK]"
    }

    # Check tailscale
    if ($gw.tailscale -and $gw.tailscale.mode -ne "off") {
        Log "  tailscale=$($gw.tailscale.mode) (external access -- verify intent)"
    } else {
        Log "  tailscale=off [OK]"
    }

    # Check port
    Log "  port=$($gw.port)"

    # Check Discord groupPolicy
    $ch = $configRaw.channels
    if ($ch.discord -and $ch.discord.groupPolicy -eq "open") {
        $issues += "INFO: Discord groupPolicy=open -- consider allowlist for production"
    }

    if ($issues.Count -gt 0) {
        foreach ($issue in $issues) {
            Log "  $issue"
        }
        Log "[WARN] Security review: $($issues.Count) item(s) noted"
    } else {
        Log "[OK] Gateway security check passed."
    }
} catch {
    Log "[WARN] Security check failed: $_"
}

# === Phase 4: Restart Gateway (if update succeeded) ===
Log "--- Phase 4: Restart ---"
try {
    $svc = Get-ScheduledTask -TaskName "Moltbot Gateway" -ErrorAction SilentlyContinue
    if ($svc -and $svc.State -eq "Running") {
        Log "  Gateway task is running [OK]"
    } elseif ($svc) {
        Log "  Gateway task state: $($svc.State) -- attempting start"
        Start-ScheduledTask -TaskName "Moltbot Gateway"
        Log "  Gateway task started"
    } else {
        Log "  [WARN] Gateway scheduled task not found"
    }
} catch {
    Log "[WARN] Restart check failed: $_"
}

# === Summary ===
Log "--- Done ---"
Log "[Moltbot] Update routine complete. Log: $LogFile"
