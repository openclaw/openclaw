# ─────────────────────────────────────────────────────────────────────────────
# O.R.I.O.N. Universal Deployer — Windows (PowerShell 5.1+)
#
# One-liner:
#   irm https://raw.githubusercontent.com/zacharyjleach-stack/O.R.I.O.N./main/bin/setup.ps1 | iex
#
# What it does:
#   1. Ensures Node.js >= 22, pnpm, and Ollama are installed
#   2. Pulls the llama3 model via Ollama
#   3. Installs dependencies & builds the project
#   4. Writes ~/.openclaw/openclaw.json with a local Ollama provider
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"

function Write-Info  { param($msg) Write-Host "[O.R.I.O.N.] $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "[O.R.I.O.N.] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[O.R.I.O.N.] $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "[O.R.I.O.N.] $msg" -ForegroundColor Red; exit 1 }

# ── Helper: test if a command exists ─────────────────────────────────────────
function Test-Command { param($cmd) return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ── Helper: compare semver (returns $true if $a >= $b) ──────────────────────
function Test-VersionGte {
    param([string]$a, [string]$b)
    return ([version]$a -ge [version]$b)
}

# ── 1. Node.js >= 22 ────────────────────────────────────────────────────────
function Install-NodeJs {
    if (Test-Command "node") {
        $ver = (node -v) -replace '^v', ''
        if (Test-VersionGte $ver "22.0.0") {
            Write-Ok "Node.js $ver already installed (>= 22)"
            return
        }
        Write-Warn "Node.js $ver found but < 22; installing newer version..."
    } else {
        Write-Info "Node.js not found; installing..."
    }

    if (Test-Command "winget") {
        winget install --id OpenJS.NodeJS --version 22 --accept-source-agreements --accept-package-agreements
    } elseif (Test-Command "choco") {
        choco install nodejs --version=22 -y
    } else {
        Write-Fail "Neither winget nor choco found. Install Node.js >= 22 manually: https://nodejs.org"
    }

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (-not (Test-Command "node")) {
        Write-Fail "Node.js installation succeeded but 'node' not in PATH. Restart your terminal and re-run."
    }

    $ver = (node -v) -replace '^v', ''
    if (-not (Test-VersionGte $ver "22.0.0")) {
        Write-Fail "Failed to install Node.js >= 22 (got $ver)"
    }
    Write-Ok "Node.js $ver installed"
}

# ── 2. pnpm ──────────────────────────────────────────────────────────────────
function Install-Pnpm {
    if (Test-Command "pnpm") {
        Write-Ok "pnpm $(pnpm -v) already installed"
        return
    }
    Write-Info "Installing pnpm..."
    try {
        $ErrorActionPreference = "Continue"
        corepack enable 2>&1 | Out-Null
        $ErrorActionPreference = "Stop"
    } catch {
        npm install -g pnpm
    }
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (-not (Test-Command "pnpm")) {
        Write-Fail "Failed to install pnpm"
    }
    Write-Ok "pnpm $(pnpm -v) installed"
}

# ── 3. Ollama ────────────────────────────────────────────────────────────────
function Install-Ollama {
    if (Test-Command "ollama") {
        Write-Ok "Ollama already installed"
        return
    }
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

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (-not (Test-Command "ollama")) {
        Write-Fail "Ollama installation succeeded but 'ollama' not in PATH. Restart your terminal and re-run."
    }
    Write-Ok "Ollama installed"
}

# ── 4. Pull llama3 model ────────────────────────────────────────────────────
function Pull-Model {
    Write-Info "Ensuring Ollama is running..."

    # Try to start the Ollama service if not already running
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

# ── 5. Build project ────────────────────────────────────────────────────────
function Build-Project {
    if (-not (Test-Path "package.json")) {
        Write-Fail "Run this script from the openclaw project root (where package.json lives)"
    }

    Write-Info "Installing dependencies..."
    pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "pnpm install failed" }

    Write-Info "Building project..."
    pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Fail "pnpm build failed" }

    Write-Ok "Build complete"
}

# ── 6. Generate config ──────────────────────────────────────────────────────
function New-OrionConfig {
    $configDir = Join-Path $HOME ".openclaw"
    $configFile = Join-Path $configDir "openclaw.json"

    if (Test-Path $configFile) {
        Write-Warn "Config already exists at $configFile - skipping generation."
        Write-Warn "To regenerate, delete it and re-run this script."
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
    Write-Ok "Config written to $configFile"
}

# ── Main ─────────────────────────────────────────────────────────────────────
function Main {
    Write-Host ""
    Write-Host "  +=============================================+" -ForegroundColor Cyan
    Write-Host "  |   O.R.I.O.N. - Universal Deployer (v1)     |" -ForegroundColor Cyan
    Write-Host "  +=============================================+" -ForegroundColor Cyan
    Write-Host ""

    Install-NodeJs
    Install-Pnpm
    Install-Ollama
    Pull-Model
    Build-Project
    New-OrionConfig

    Write-Host ""
    Write-Ok "O.R.I.O.N. is ready!"
    Write-Host ""
    Write-Host "  Start the gateway:" -ForegroundColor White
    Write-Host "    node openclaw.mjs gateway run --dev" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Then open the web UI at:" -ForegroundColor White
    Write-Host "    http://localhost:18789/__openclaw__/canvas/" -ForegroundColor Cyan
    Write-Host ""
}

Main
