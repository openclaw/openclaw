#!/usr/bin/env pwsh
# GGUFモデルをOllamaにGPU付きでインポートするスクリプト

$MODEL_PATH = "C:/Users/downl/Desktop/SO8T/gguf_models/lmstudio-community/rnj-1-instruct-GGUF/rnj-1-instruct-Q4_K_M.gguf"
$MODEL_NAME = "rnj-1-instruct"

Write-Host "=== Ollama GPU Import Script ===" -ForegroundColor Cyan
Write-Host ""

# Ollamaサービス確認
Write-Host "[1/4] Ollamaサービスを起動中..." -ForegroundColor Yellow
$ollama = Get-Process ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    Write-Host "Ollamaを起動しています..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 5
}

# Modelfile作成（GPU有効化）
$MODFILE_PATH = [System.IO.Path]::GetTempFileName()
@"
FROM '$MODEL_PATH'
PARAMETER temperature 0.7
PARAMETER top_p 0.9
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|im_start|>"
"@ | Out-File -FilePath $MODFILE_PATH -Encoding UTF8

Write-Host "[2/4] Modelfileを作成しました (GPU有効化済み)" -ForegroundColor Yellow

# 既存モデル削除（ある場合）
Write-Host "[3/4] モデルをインポート中..." -ForegroundColor Yellow
try {
    ollama rm $MODEL_NAME 2>$null | Out-Null
} catch {}

# モデル作成（GPU自動使用）
$env:OLLAMA_GPU = "1"
$env:CUDA_VISIBLE_DEVICES = "0"
& ollama create $MODEL_NAME -f $MODFILE_PATH

Remove-Item -Path $MODFILE_PATH -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "[4/4] モデルを確認中..." -ForegroundColor Yellow
ollama list

Write-Host ""
Write-Host "=== 完了 ===" -ForegroundColor Green
Write-Host "OpenClawで使用するには以下を設定:" -ForegroundColor White
Write-Host "  set OLLAMA_API_KEY=anything" -ForegroundColor Yellow
Write-Host "  openclaw config set agents.defaults.model.primary 'ollama/$MODEL_NAME'" -ForegroundColor Yellow
Write-Host ""
Write-Host "GPU使用確認: ollama run $MODEL_NAME 'Hello'" -ForegroundColor Cyan
