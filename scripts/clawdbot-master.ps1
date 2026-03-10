# Clawdbot-Master v3.2: Unified Orchestrator
# Brain: qwen3.5:9b (Ollama) | Fallback: openai-codex/gpt-5.4
# Delegates core stack to launch-desktop-stack.ps1

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PassthroughArgs
)

$Host.UI.RawUI.WindowTitle = "Clawdbot Master v3.2"
$ProjectDir = (Get-Item $PSScriptRoot).Parent.FullName
$LauncherPs1 = Join-Path $ProjectDir "scripts\launchers\launch-desktop-stack.ps1"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Clawdbot Master System v3.2"            -ForegroundColor Magenta
Write-Host " Brain  : ollama/qwen3.5:9b"             -ForegroundColor Cyan
Write-Host " Fallbk : openai-codex/gpt-5.4"          -ForegroundColor Cyan
Write-Host " TTS    : VOICEVOX"                       -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# [Pre] Ensure Ollama is running
Write-Host "[Pre] Checking Ollama (qwen3.5:9b brain)..." -ForegroundColor White
$ollamaProc = Get-Process ollama -ErrorAction SilentlyContinue
if (-not $ollamaProc) {
    $ollamaCmd = Get-Command "ollama" -ErrorAction SilentlyContinue
    if ($ollamaCmd) {
        Write-Host "  - Starting Ollama..." -ForegroundColor Gray
        Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Minimized
        Start-Sleep -Seconds 3
        Write-Host "  - Ollama started." -ForegroundColor Green
    } else {
        Write-Host "  - WARNING: ollama not found in PATH. Skipping." -ForegroundColor Yellow
    }
} else {
    Write-Host "  - Ollama already running (PID: $($ollamaProc.Id))." -ForegroundColor Green
}

# Delegate to launch-desktop-stack.ps1
Write-Host ""
Write-Host "Handing off to OpenClaw Desktop Stack..." -ForegroundColor Cyan
Write-Host ""

& powershell.exe -ExecutionPolicy Bypass -File $LauncherPs1 -SpeakOnReady @PassthroughArgs
