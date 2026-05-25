#!/usr/bin/env pwsh
# 💥 ALPHABET HARVESTER BLAST SCRIPT 💥
# Sendir AI repos og model repos í Harvester API-ið

Write-Host @"

    ╔═══════════════════════════════════════════════╗
    ║   🔥  ALPHABET HARVESTER BLAST v3.1  🔥     ║
    ║   🤖  AI Domination Repo Swarm Online  🤖   ║
    ╚═══════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

$API_BASE = "http://localhost:8080"

# Athuga hvort backend sé lifandi
Write-Host "`n🏥 Athuga Backend..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$API_BASE/api/health" -TimeoutSec 3
    Write-Host "✅ Backend er LIVE! (Uptime: $([math]::Round($health.uptime))s)`n" -ForegroundColor Green
}
catch {
    Write-Host "❌ Backend er EKKI að svara á $API_BASE" -ForegroundColor Red
    Write-Host "   Keyrðu: docker-compose up -d alpacore" -ForegroundColor Yellow
    exit 1
}

# Opin AI repos/model repos sem við viljum harvest-a með hóflegu throttle
$targets = @(
    "https://api.github.com/repos/pytorch/pytorch",
    "https://api.github.com/repos/huggingface/transformers",
    "https://api.github.com/repos/langchain-ai/langchain",
    "https://api.github.com/repos/Significant-Gravitas/Auto-GPT",
    "https://api.github.com/repos/hwchase17/langchain",
    "https://api.github.com/repos/karpathy/nanoGPT",
    "https://api.github.com/repos/google/jax",
    "https://api.github.com/repos/openai/whisper",
    "https://api.github.com/repos/openai/openai-python",
    "https://api.github.com/repos/vllm-project/vllm",
    "https://api.github.com/repos/run-llama/llama_index",
    "https://api.github.com/repos/ollama/ollama",
    "https://api.github.com/repos/scikit-learn/scikit-learn",
    "https://api.github.com/repos/keras-team/keras",
    "https://api.github.com/repos/deepspeedai/DeepSpeed",
    "https://api.github.com/repos/mlflow/mlflow",
    "https://api.github.com/repos/triton-lang/triton",
    "https://api.github.com/repos/lm-sys/FastChat",
    "https://api.github.com/repos/Lightning-AI/pytorch-lightning",
    "https://api.github.com/repos/microsoft/onnxruntime",
    "https://huggingface.co/api/models/gradientai/Llama-3-8B-Instruct-262k",
    "https://huggingface.co/api/models/QuantFactory/Meta-Llama-3-8B-GGUF",
    "https://huggingface.co/api/models/NousResearch/Hermes-2-Pro-Llama-3-8B"
)

$gatedTargets = @(
    "https://huggingface.co/api/models/meta-llama/Meta-Llama-3-8B",
    "https://huggingface.co/api/models/meta-llama/Meta-Llama-3-8B-Instruct",
    "https://huggingface.co/api/models/zaya-ai/zaya-1-8b"
)

Write-Host "💥 RÆSUM BLAST! Sendir $($targets.Count) opin AI repos/model repos...`n" -ForegroundColor Magenta

$success = 0
$failed = 0
$skipped = 0

foreach ($url in $targets) {
    try {
        $body = @{ url = $url } | ConvertTo-Json
        $null = Invoke-RestMethod -Uri "$API_BASE/api/targets" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 5
        Write-Host "  ✅ " -ForegroundColor Green -NoNewline
        Write-Host "$url" -ForegroundColor Cyan
        $success++
        Start-Sleep -Milliseconds 150
    }
    catch {
        Write-Host "  ❌ " -ForegroundColor Red -NoNewline
        Write-Host "$url - $($_.Exception.Message)" -ForegroundColor Gray
        $failed++
    }
}

foreach ($url in $gatedTargets) {
    Write-Host "  🔒 " -ForegroundColor Yellow -NoNewline
    Write-Host "$url - gated Hugging Face model; þarf HF auth support í harvester áður en við queue-um það" -ForegroundColor Gray
    $skipped++
}

Write-Host "`n╔═══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║         💥 BLAST LOKIÐ! 💥              ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════╝`n" -ForegroundColor Cyan

Write-Host "📊 Niðurstöður:" -ForegroundColor Yellow
Write-Host "   ✅ Sendir: $success" -ForegroundColor Green
Write-Host "   ❌ Mistókust: $failed" -ForegroundColor Red
Write-Host "   🔒 Sleppt gated: $skipped" -ForegroundColor Yellow
Write-Host "   📋 Alls: $($targets.Count + $gatedTargets.Count)" -ForegroundColor Cyan

# Sækja stats eftir blast
Write-Host "`n⏳ Bíðum í 2 sek og sækjum stats...`n" -ForegroundColor Yellow
Start-Sleep -Seconds 2

try {
    $stats = Invoke-RestMethod -Uri "$API_BASE/api/targets"
    Write-Host "🎯 Harvester Stats:" -ForegroundColor Magenta
    Write-Host "   🔧 Workers: $($stats.stats.workers)" -ForegroundColor Cyan
    Write-Host "   ⚡ Active: $($stats.stats.active)" -ForegroundColor Yellow
    Write-Host "   ✅ Completed: $($stats.stats.completed)" -ForegroundColor Green
    Write-Host "   ❌ Failed: $($stats.stats.failed)" -ForegroundColor Red
    Write-Host "   📋 Total Targets: $($stats.targets.Count)" -ForegroundColor Magenta

    Write-Host "`n🌐 Sjá rauntíma progress á: http://localhost:5173" -ForegroundColor Cyan
    Write-Host "💡 Tip: Opnaðu UI-ið til að sjá logs streyma inn!`n" -ForegroundColor Yellow
}
catch {
    Write-Host "⚠️ Gat ekki sótt stats, en targets voru sendir!" -ForegroundColor Yellow
}

Write-Host "🔥 ALPHABET-VELDIÐ ER VIRKT! 🔥`n" -ForegroundColor Green
