#!/usr/bin/env pwsh
# OpenClaw + Ollama GGUF GPU Auto Setup

$MODEL_PATH = "C:/Users/downl/Desktop/SO8T/gguf_models/lmstudio-community/rnj-1-instruct-GGUF/rnj-1-instruct-Q4_K_M.gguf"
$MODEL_NAME = "rnj-1-instruct"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OpenClaw Ollama GPU Auto Setup" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Ollama service
Write-Host "[Step 1/5] Starting Ollama service..." -ForegroundColor Yellow
$ollamaProc = Get-Process ollama -ErrorAction SilentlyContinue
if (-not $ollamaProc) {
    Write-Host "  Starting Ollama in background..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 5
    Write-Host "  [OK] Ollama started" -ForegroundColor Green
} else {
    Write-Host "  [OK] Ollama already running" -ForegroundColor Green
}

# Step 2: Environment variables
Write-Host ""
Write-Host "[Step 2/5] Setting GPU environment variables..." -ForegroundColor Yellow
[Environment]::SetEnvironmentVariable("OLLAMA_API_KEY", "anything", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_GPU", "1", "User")
Write-Host "  [OK] OLLAMA_API_KEY=anything"
Write-Host "  [OK] OLLAMA_GPU=1"

# Step 3: Import GGUF model
Write-Host ""
Write-Host "[Step 3/5] Importing GGUF model..." -ForegroundColor Yellow
if (-not (Test-Path $MODEL_PATH)) {
    Write-Host "  [ERROR] Model file not found" -ForegroundColor Red
    exit 1
}

$EXISTING_MODFILE = "C:/Users/downl/Desktop/SO8T/gguf_models/lmstudio-community/rnj-1-instruct-GGUF/Modelfile"
$MODFILE_PATH = [System.IO.Path]::GetTempFileName()

if (Test-Path $EXISTING_MODFILE) {
    Get-Content $EXISTING_MODFILE | Out-File -FilePath $MODFILE_PATH -Encoding UTF8 -Append
    "`nPARAMETER num_ctx 32768" | Out-File -FilePath $MODFILE_PATH -Encoding UTF8 -Append
    Write-Host "  Using existing Modelfile + GPU optimization" -ForegroundColor Green
} else {
    @"
FROM '$MODEL_PATH'
PARAMETER temperature 0.7
PARAMETER top_p 0.9
PARAMETER num_ctx 32768
"@ | Out-File -FilePath $MODFILE_PATH -Encoding UTF8
    Write-Host "  Created new Modelfile" -ForegroundColor Green
}

try {
    ollama rm $MODEL_NAME 2>$null | Out-Null
} catch {}

$env:OLLAMA_GPU = "1"
ollama create $MODEL_NAME -f $MODFILE_PATH
Remove-Item -Path $MODFILE_PATH -ErrorAction SilentlyContinue
Write-Host "  [OK] Model import complete" -ForegroundColor Green

# Step 4: Configure OpenClaw
Write-Host ""
Write-Host "[Step 4/5] Configuring OpenClaw..." -ForegroundColor Yellow
$env:OLLAMA_API_KEY = "anything"

try {
    $result = node scripts/run-node.mjs config set agents.defaults.model.primary "ollama/$MODEL_NAME" 2>&1
    if ($result -match "Updated|updated") {
        Write-Host "  [OK] agents.defaults.model.primary = ollama/$MODEL_NAME" -ForegroundColor Green
    } else {
        Write-Host "  [WARNING] OpenClaw config may need manual update" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [WARNING] Could not configure OpenClaw automatically" -ForegroundColor Yellow
}

# Step 5: Verify
Write-Host ""
Write-Host "[Step 5/5] Verifying installation..." -ForegroundColor Yellow
$models = ollama list 2>$null
if ($models -match $MODEL_NAME) {
    Write-Host "  [OK] $MODEL_NAME installed" -ForegroundColor Green
} else {
    Write-Host "  [ERROR] Model not found" -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. openclaw restart" -ForegroundColor Cyan
Write-Host ""
Write-Host "GPU verification:" -ForegroundColor White
Write-Host "  ollama run $MODEL_NAME 'Hello'" -ForegroundColor Cyan
