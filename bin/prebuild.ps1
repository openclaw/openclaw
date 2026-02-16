# -----------------------------------------------------------------------------
# O.R.I.O.N. All-In-One Prebuild -- Windows (PowerShell 5.1+)
#
# Zero-to-running: installs ALL prerequisites, clones the repo, and builds.
#
# One-liner (paste into any PowerShell window):
#   iwr https://raw.githubusercontent.com/zacharyjleach-stack/O.R.I.O.N/main/bin/prebuild.ps1 -OutFile "$env:TEMP\prebuild.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\prebuild.ps1"
#
# Or save and run with flags:
#   .\prebuild.ps1 -InstallDir "D:\Projects"
#   .\prebuild.ps1 -SkipOllama -SkipPython -SkipPlaywright
#   .\prebuild.ps1 -Branch dev
#
# What it does (13 steps):
#   1.  Installs Git (winget or choco)
#   2.  Installs Node.js 22+ (winget or choco)
#   3.  Installs pnpm (corepack or npm)
#   4.  Installs Python 3.10+ (winget or choco)
#   5.  Installs Ollama + pulls llama3 model
#   6.  Clones the O.R.I.O.N. repository
#   7.  Installs Node dependencies (pnpm install)
#   8.  Installs UI workspace dependencies
#   9.  Installs Python brain dependencies (requirements.txt)
#  10.  Installs Playwright Chromium browser
#  11.  Builds UI (Vite)
#  12.  Builds TypeScript (tsdown + post-build scripts)
#  13.  Generates ~/.openclaw/openclaw.json config
#  14.  Verifies the full build
# -----------------------------------------------------------------------------
param(
    [string]$InstallDir   = (Join-Path $HOME "O.R.I.O.N"),
    [string]$Branch       = "main",
    [string]$RepoUrl      = "https://github.com/zacharyjleach-stack/O.R.I.O.N.git",
    [switch]$SkipOllama,
    [switch]$SkipPython,
    [switch]$SkipPlaywright,
    [switch]$SkipClone
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

# ==============================================================================
#  LOGGING
# ==============================================================================
function Write-Banner { param($msg) Write-Host ("`n>>> " + $msg) -ForegroundColor Magenta }
function Write-Info   { param($msg) Write-Host ("  [O.R.I.O.N.] " + $msg) -ForegroundColor Cyan }
function Write-Ok     { param($msg) Write-Host ("  [O.R.I.O.N.] " + $msg) -ForegroundColor Green }
function Write-Warn   { param($msg) Write-Host ("  [O.R.I.O.N.] " + $msg) -ForegroundColor Yellow }
function Write-Fail   { param($msg) Write-Host ("  [O.R.I.O.N.] ERROR: " + $msg) -ForegroundColor Red; exit 1 }
function Write-Step   { param($num, $total, $msg) Write-Host ("`n  [" + $num + "/" + $total + "] " + $msg) -ForegroundColor White }

# ==============================================================================
#  UTILITIES
# ==============================================================================
function Test-Command {
    param($cmd)
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Test-VersionGte {
    param([string]$a, [string]$b)
    return ([version]$a -ge [version]$b)
}

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# -- Step counter --------------------------------------------------------------
$totalSteps = 13
if ($SkipOllama)     { $totalSteps -= 1 }
if ($SkipPython)     { $totalSteps -= 1 }
if ($SkipPlaywright) { $totalSteps -= 1 }
if ($SkipClone)      { $totalSteps -= 1 }
$stepNum = 0

function Next-Step { param($msg) $script:stepNum++; Write-Step $script:stepNum $totalSteps $msg }

# ==============================================================================
#  STEP IMPLEMENTATIONS
# ==============================================================================

# -- 1. Git --------------------------------------------------------------------
function Install-Git {
    if (Test-Command "git") {
        $ver = (git --version) -replace 'git version\s*', ''
        Write-Ok ("Git " + $ver + " already installed")
        return
    }
    Write-Info "Git not found; installing..."
    if (Test-Command "winget") {
        winget install --id Git.Git --accept-source-agreements --accept-package-agreements
    } elseif (Test-Command "choco") {
        choco install git -y
    } else {
        Write-Fail 'Neither winget nor choco found. Install Git manually: https://git-scm.com/download/win'
    }
    Refresh-Path
    if (-not (Test-Command "git")) {
        Write-Fail "Git installed but not in PATH. Restart your terminal and re-run."
    }
    Write-Ok "Git installed"
}

# -- 2. Node.js 22+ -----------------------------------------------------------
function Install-NodeJs {
    if (Test-Command "node") {
        $ver = (node -v) -replace '^v', ''
        if (Test-VersionGte $ver "22.0.0") {
            Write-Ok ("Node.js " + $ver + " already installed (22+)")
            return
        }
        Write-Warn ("Node.js " + $ver + " found but older than 22; upgrading...")
    } else {
        Write-Info "Node.js not found; installing..."
    }

    if (Test-Command "winget") {
        winget install --id OpenJS.NodeJS --version 22 --accept-source-agreements --accept-package-agreements
    } elseif (Test-Command "choco") {
        choco install nodejs --version=22 -y
    } else {
        Write-Fail 'Neither winget nor choco found. Install Node.js 22+ manually: https://nodejs.org'
    }
    Refresh-Path
    if (-not (Test-Command "node")) {
        Write-Fail "Node.js installed but not in PATH. Restart your terminal and re-run."
    }
    $ver = (node -v) -replace '^v', ''
    if (-not (Test-VersionGte $ver "22.0.0")) {
        Write-Fail ("Failed to get Node.js 22+ (got " + $ver + ")")
    }
    Write-Ok ("Node.js " + $ver + " installed")
}

# -- 3. pnpm ------------------------------------------------------------------
function Install-Pnpm {
    if (Test-Command "pnpm") {
        Write-Ok ("pnpm " + (pnpm -v) + " already installed")
        return
    }
    Write-Info "Installing pnpm..."
    try {
        $ErrorActionPreference = "Continue"
        corepack enable 2>&1 | Out-Null
        corepack prepare pnpm@latest --activate 2>&1 | Out-Null
        $ErrorActionPreference = "Stop"
    } catch {
        npm install -g pnpm
    }
    Refresh-Path
    if (-not (Test-Command "pnpm")) {
        Write-Fail "Failed to install pnpm"
    }
    Write-Ok ("pnpm " + (pnpm -v) + " installed")
}

# -- 4. Python 3.10+ ----------------------------------------------------------
function Install-Python {
    $script:pythonCmd = $null
    foreach ($cmd in @("python3", "python", "py")) {
        if (Test-Command $cmd) {
            $ver = & $cmd --version 2>&1
            if ($ver -match '(\d+\.\d+\.\d+)') {
                if (Test-VersionGte $Matches[1] "3.10.0") {
                    $script:pythonCmd = $cmd
                    Write-Ok ("Python " + $Matches[1] + " already installed (3.10+)")
                    return
                }
            }
        }
    }

    Write-Info 'Python 3.10+ not found; installing...'
    if (Test-Command "winget") {
        winget install --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    } elseif (Test-Command "choco") {
        choco install python312 -y
    } else {
        Write-Fail 'Neither winget nor choco found. Install Python 3.10+ manually: https://python.org'
    }
    Refresh-Path
    foreach ($cmd in @("python3", "python", "py")) {
        if (Test-Command $cmd) { $script:pythonCmd = $cmd; break }
    }
    if (-not $script:pythonCmd) {
        Write-Fail "Python installed but not in PATH. Restart your terminal and re-run."
    }
    Write-Ok "Python installed"
}

# -- 5. Ollama + llama3 -------------------------------------------------------
function Install-Ollama {
    if (Test-Command "ollama") {
        Write-Ok "Ollama already installed"
    } else {
        Write-Info "Installing Ollama..."
        if (Test-Command "winget") {
            winget install --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
        } else {
            Write-Info "Downloading Ollama installer..."
            $installer = Join-Path $env:TEMP "OllamaSetup.exe"
            Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $installer
            Start-Process -FilePath $installer -ArgumentList "/S" -Wait
            Remove-Item $installer -ErrorAction SilentlyContinue
        }
        Refresh-Path
        if (-not (Test-Command "ollama")) {
            Write-Fail "Ollama installed but not in PATH. Restart your terminal and re-run."
        }
        Write-Ok "Ollama installed"
    }

    # Start Ollama and pull model
    Write-Info "Ensuring Ollama is running..."
    try {
        $result = ollama list 2>&1
        if ($LASTEXITCODE -ne 0) { throw "not running" }
    } catch {
        Write-Info "Starting Ollama in the background..."
        Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
        Start-Sleep -Seconds 5
    }

    Write-Info "Pulling llama3 (this may take a while on first run)..."
    ollama pull llama3
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to pull llama3 model" }
    Write-Ok "llama3 model ready"
}

# -- 6. Clone repository ------------------------------------------------------
function Clone-Repository {
    if (Test-Path (Join-Path $InstallDir "package.json")) {
        Write-Info ("Repository already exists at " + $InstallDir)
        Write-Info ("Pulling latest changes on branch '" + $Branch + "'...")
        Push-Location $InstallDir
        # Git writes progress/info to stderr which PS 5.1 treats as a
        # NativeCommandError when $ErrorActionPreference is Stop.
        # SilentlyContinue fully suppresses stderr ErrorRecords in PS 5.1.
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        $null = (git fetch origin 2>&1)
        $null = (git checkout $Branch 2>&1)
        $pullOutput = (git pull origin $Branch 2>&1) | Out-String
        $ErrorActionPreference = $prevEAP
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "git pull failed; continuing with existing code"
        } else {
            Write-Ok "Repository updated"
        }
        Pop-Location
        return
    }

    # Ensure parent directory exists
    $parentDir = Split-Path $InstallDir -Parent
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }

    Write-Info ("Cloning O.R.I.O.N. into " + $InstallDir + " ...")
    git clone --branch $Branch --single-branch --depth 1 $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Shallow clone failed; trying full clone..."
        git clone --branch $Branch $RepoUrl $InstallDir
        if ($LASTEXITCODE -ne 0) { Write-Fail ("Failed to clone repository from " + $RepoUrl) }
    }
    Write-Ok ("Repository cloned to " + $InstallDir)
}

# -- 7. pnpm install ----------------------------------------------------------
function Install-Dependencies {
    Write-Info "Running pnpm install..."
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Frozen lockfile failed, retrying with regular install..."
        pnpm install
        if ($LASTEXITCODE -ne 0) { Write-Fail "pnpm install failed" }
    }
    Write-Ok "Node dependencies installed"
}

# -- 8. UI workspace dependencies ---------------------------------------------
function Install-UIDependencies {
    if (Test-Path "ui/package.json") {
        Write-Info "Installing UI workspace dependencies..."
        pnpm --dir ui install
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "UI install failed; trying ui:install script..."
            pnpm ui:install
            if ($LASTEXITCODE -ne 0) { Write-Fail "UI dependency install failed" }
        }
        Write-Ok "UI dependencies installed"
    } else {
        Write-Warn "ui/package.json not found; skipping UI dependencies"
    }
}

# -- 9. Python brain dependencies ---------------------------------------------
function Install-PythonDeps {
    if (-not $script:pythonCmd) {
        foreach ($cmd in @("python3", "python", "py")) {
            if (Test-Command $cmd) { $script:pythonCmd = $cmd; break }
        }
    }
    if (-not $script:pythonCmd) {
        Write-Warn "Python not available; skipping brain dependencies"
        return
    }

    if (Test-Path "requirements.txt") {
        Write-Info "Installing Python brain dependencies..."
        $ErrorActionPreference = "Continue"
        & $script:pythonCmd -m pip install --upgrade pip 2>&1 | Out-Null
        & $script:pythonCmd -m pip install -r requirements.txt 2>&1
        $ErrorActionPreference = "Stop"
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Some Python deps failed. Brain features may not work."
        } else {
            Write-Ok "Python brain dependencies installed"
        }
    } else {
        Write-Warn "requirements.txt not found; skipping Python deps"
    }
}

# -- 10. Playwright browsers --------------------------------------------------
function Install-PlaywrightBrowsers {
    # Store browsers inside the project (avoids "Access is denied" on global path)
    $env:PLAYWRIGHT_BROWSERS_PATH = "0"

    Write-Info "Installing Playwright Chromium browser..."
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $null = (npx playwright install chromium --force 2>&1)
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Playwright browser install failed. Browser automation may not work."
    } else {
        Write-Ok "Playwright Chromium installed"
    }

    Write-Info "Installing Playwright system dependencies..."
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $null = (npx playwright install-deps chromium 2>&1)
    $ErrorActionPreference = $prevEAP
    Write-Ok "Playwright setup complete"
}

# -- 11. Build UI -------------------------------------------------------------
function Build-UI {
    Write-Info "Building UI..."
    pnpm ui:build
    if ($LASTEXITCODE -ne 0) { Write-Fail "UI build failed" }
    Write-Ok "UI built"
}

# -- 12. Build TypeScript -----------------------------------------------------
function Build-TypeScript {
    Write-Info "Building TypeScript (full build pipeline)..."
    pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Fail "TypeScript build failed" }
    Write-Ok "TypeScript build complete"
}

# -- 13. Generate config ------------------------------------------------------
function New-OrionConfig {
    $configDir  = Join-Path $HOME ".openclaw"
    $configFile = Join-Path $configDir "openclaw.json"

    if (Test-Path $configFile) {
        Write-Warn ("Config already exists at " + $configFile + " -- skipping.")
        Write-Warn "Delete it and re-run to regenerate."
        return
    }

    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $config = @'
{
  "env": {
    "vars": {
      "OLLAMA_API_KEY": "ollama"
    }
  },
  "models": {
    "providers": {
      "local_ollama": {
        "baseUrl": "http://127.0.0.1:11434/v1",
        "api": "openai-completions",
        "apiKey": "ollama",
        "models": [
          {
            "id": "llama3",
            "name": "Llama 3",
            "reasoning": false,
            "contextWindow": 16384,
            "maxTokens": 4096,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "local_ollama/llama3"
    }
  }
}
'@

    Set-Content -Path $configFile -Value $config -Encoding UTF8
    Write-Ok ("Config written to " + $configFile)
}

# -- Verify build --------------------------------------------------------------
function Verify-Build {
    Write-Banner "Verifying build artifacts..."

    $checks = @(
        @{ Path = "dist/index.js";            Label = "Main entry (dist/index.js)" },
        @{ Path = "dist/entry.js";            Label = "CLI entry (dist/entry.js)" },
        @{ Path = "dist/plugin-sdk/index.js"; Label = "Plugin SDK (dist/plugin-sdk/index.js)" },
        @{ Path = "openclaw.mjs";             Label = "CLI launcher (openclaw.mjs)" },
        @{ Path = "node_modules";             Label = "node_modules" }
    )

    $allOk = $true
    foreach ($check in $checks) {
        if (Test-Path $check.Path) {
            Write-Ok $check.Label
        } else {
            Write-Warn ("MISSING: " + $check.Label)
            $allOk = $false
        }
    }

    if (-not $allOk) {
        Write-Warn "Some build artifacts are missing. The build may be incomplete."
    } else {
        Write-Ok "All build artifacts verified"
    }
}

# ==============================================================================
#  MAIN
# ==============================================================================
function Main {
    Write-Host ""
    Write-Host "  +=========================================================+" -ForegroundColor Cyan
    Write-Host "  |                                                         |" -ForegroundColor Cyan
    Write-Host "  |   O.R.I.O.N. -- All-In-One Prebuild (Windows v2)       |" -ForegroundColor Cyan
    Write-Host "  |                                                         |" -ForegroundColor Cyan
    Write-Host "  |   Clone + Install + Build -- one command, zero config   |" -ForegroundColor Cyan
    Write-Host "  |                                                         |" -ForegroundColor Cyan
    Write-Host "  +=========================================================+" -ForegroundColor Cyan
    Write-Host ""
    Write-Info ("Install directory : " + $InstallDir)
    Write-Info ("Branch            : " + $Branch)
    Write-Info ("Skip Ollama       : " + $SkipOllama)
    Write-Info ("Skip Python       : " + $SkipPython)
    Write-Info ("Skip Playwright   : " + $SkipPlaywright)
    Write-Host ""

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # -- Phase 1: System Prerequisites ----------------------------------------
    Write-Banner "Phase 1/4 -- System Prerequisites"

    Next-Step "Installing Git"
    Install-Git

    Next-Step 'Installing Node.js 22+'
    Install-NodeJs

    Next-Step "Installing pnpm"
    Install-Pnpm

    if (-not $SkipPython) {
        Next-Step 'Installing Python 3.10+'
        Install-Python
    }

    if (-not $SkipOllama) {
        Next-Step "Installing Ollama + pulling llama3"
        Install-Ollama
    }

    # -- Phase 2: Clone Repository --------------------------------------------
    Write-Banner "Phase 2/4 -- Repository"

    if (-not $SkipClone) {
        Next-Step "Cloning O.R.I.O.N. repository"
        Clone-Repository
    }

    # cd into project for remaining steps
    Set-Location $InstallDir
    Write-Info ("Working directory: " + (Get-Location))

    # -- Phase 3: Dependencies ------------------------------------------------
    Write-Banner "Phase 3/4 -- Dependencies"

    Next-Step "Installing Node dependencies (pnpm install)"
    Install-Dependencies

    Next-Step "Installing UI workspace dependencies"
    Install-UIDependencies

    if (-not $SkipPython) {
        Next-Step "Installing Python brain dependencies"
        Install-PythonDeps
    }

    if (-not $SkipPlaywright) {
        Next-Step "Installing Playwright browsers"
        Install-PlaywrightBrowsers
    }

    # -- Phase 4: Build -------------------------------------------------------
    Write-Banner "Phase 4/4 -- Build"

    Next-Step "Building UI (Vite)"
    Build-UI

    Next-Step "Building TypeScript (tsdown)"
    Build-TypeScript

    Next-Step "Generating O.R.I.O.N. config"
    New-OrionConfig

    # -- Done -----------------------------------------------------------------
    Verify-Build

    $sw.Stop()
    $mins = [math]::Floor($sw.Elapsed.TotalMinutes)
    $secs = $sw.Elapsed.Seconds

    Write-Host ""
    Write-Host "  +=========================================================+" -ForegroundColor Green
    Write-Host "  |                                                         |" -ForegroundColor Green
    Write-Host ("  |   O.R.I.O.N. is ready!  (" + $mins + "m " + $secs + "s)                          |") -ForegroundColor Green
    Write-Host "  |                                                         |" -ForegroundColor Green
    Write-Host "  +=========================================================+" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Project location:" -ForegroundColor White
    Write-Host ("    " + $InstallDir) -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Start O.R.I.O.N. (Gateway + Brain + Vision Loop):" -ForegroundColor White
    Write-Host ('    cd "' + $InstallDir + '"') -ForegroundColor Cyan
    Write-Host "    powershell -ExecutionPolicy Bypass -File bin\start.ps1" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  This launches:" -ForegroundColor White
    Write-Host "    - Node.js Gateway     http://localhost:18789/__openclaw__/canvas/" -ForegroundColor Cyan
    Write-Host "    - Python Brain        http://127.0.0.1:18790/ (health check)" -ForegroundColor Cyan
    Write-Host "    - Hippocampus         Vector memory (ChromaDB)" -ForegroundColor Cyan
    Write-Host "    - Dream State         Nightly learning at 3:00 AM" -ForegroundColor Cyan
    Write-Host "    - Scout               GitHub release monitoring (hourly)" -ForegroundColor Cyan
    Write-Host "    - Vision Loop         Desktop automation (screenshot/analyze/act)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Run tests:" -ForegroundColor White
    Write-Host "    pnpm test" -ForegroundColor Cyan
    Write-Host ""
}

# ==============================================================================
#  RUN
# ==============================================================================
Main
