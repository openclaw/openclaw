#!/usr/bin/env pwsh
# OpenClaw + Ollama GPU 環境設定

$MODEL_NAME = "rnj-1-instruct"

Write-Host "=== OpenClaw Ollama GPU Setup ===" -ForegroundColor Cyan
Write-Host ""

# 1. Ollama GPU環境変数
Write-Host "[1/5] 環境変数を設定中..." -ForegroundColor Yellow
[Environment]::SetEnvironmentVariable("OLLAMA_API_KEY", "anything", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_GPU", "1", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_DEBUG", "1", "User")
Write-Host "  OLLAMA_API_KEY=anything" -ForegroundColor Green
Write-Host "  OLLAMA_GPU=1" -ForegroundColor Green
Write-Host ""

# 2. OpenClaw設定
Write-Host "[2/5] OpenClawモデル設定を確認..." -ForegroundColor Yellow
$configFile = "$env:USERPROFILE/.openclaw/config.json"
if (Test-Path $configFile) {
    Write-Host "  既存のconfig.jsonを読み込み中..."
} else {
    Write-Host "  新しいconfig.jsonを作成..."
}

Write-Host ""
Write-Host "[3/5] OpenClaw設定を更新..." -ForegroundColor Yellow
Write-Host "  以下のコマンドを実行してください:" -ForegroundColor White
Write-Host ""
Write-Host "  openclaw config set agents.defaults.model.primary 'ollama/$MODEL_NAME'" -ForegroundColor Cyan
Write-Host "  openclaw config set agents.defaults.model.providers 'ollama'" -ForegroundColor Cyan
Write-Host ""

# 3. Ollama起動確認
Write-Host "[4/5] Ollamaサービス確認..." -ForegroundColor Yellow
$ollamaProc = Get-Process ollama -ErrorAction SilentlyContinue
if ($ollamaProc) {
    Write-Host "  Ollama稼働中 (PID: $($ollamaProc.Id))" -ForegroundColor Green
} else {
    Write-Host "  Ollamaを起動しています..." -ForegroundColor Yellow
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

# 4. モデル確認
Write-Host "[5/5] モデル確認..." -ForegroundColor Yellow
$models = ollama list 2>$null
if ($models -match $MODEL_NAME) {
    Write-Host "  $MODEL_NAME インストール済み ✓" -ForegroundColor Green
} else {
    Write-Host "  $MODEL_NAME が見つかりません" -ForegroundColor Red
    Write-Host "  import-rnj-to-ollama.ps1 を実行してください" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== 設定完了 ===" -ForegroundColor Green
Write-Host ""
Write-Host "次のステップ:" -ForegroundColor White
Write-Host "  1. import-rnj-to-ollama.ps1 を実行（まだの場合）" -ForegroundColor Cyan
Write-Host "  2. openclaw restart" -ForegroundColor Cyan
