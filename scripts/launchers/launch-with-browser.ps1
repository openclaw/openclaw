# OpenClaw ブラウザ付きランチャー
# サーバーを起動し、準備ができたらブラウザで UI を自動的に開きます。

$ErrorActionPreference = "Stop"
$ProjectDir = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$GatewayPort = 18789
$BrowserUrl  = "http://127.0.0.1:$GatewayPort"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " OpenClaw Launcher (Browser Auto-Open)" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "Project: $ProjectDir"
Write-Host "URL    : $BrowserUrl"
Write-Host ""

# --- サーバーをバックグラウンドジョブとして起動 ---
Write-Host "[1/3] OpenClaw サーバーを起動中..." -ForegroundColor Yellow
$env:OPENCLAW_GATEWAY_PORT = $GatewayPort

$serverJob = Start-Job -ScriptBlock {
    param($dir, $port)
    Set-Location -Path $dir
    $env:OPENCLAW_GATEWAY_PORT = $port
    # dist/entry.js が存在すればビルド済みバイナリを使用（高速）
    if (Test-Path (Join-Path $dir "dist\entry.js")) {
        node .\dist\entry.js gateway
    } else {
        pnpm start
    }
} -ArgumentList $ProjectDir, $GatewayPort

# --- サーバーの起動を待つ（最大60秒） ---
Write-Host "[2/3] サーバー起動を待機中..." -ForegroundColor Yellow
$maxWait   = 60
$waited    = 0
$interval  = 2
$isReady   = $false

while ($waited -lt $maxWait) {
    Start-Sleep -Seconds $interval
    $waited += $interval
    try {
        $resp = Invoke-WebRequest -Uri $BrowserUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -ge 200) {
            $isReady = $true
            break
        }
    } catch {
        # まだ起動中 — 再試行
    }
    Write-Host "  ... $waited 秒経過 (最大 ${maxWait} 秒)" -ForegroundColor DarkGray
}

# --- ブラウザを開く ---
if ($isReady) {
    Write-Host "[3/3] ブラウザを起動します: $BrowserUrl" -ForegroundColor Green
    Start-Process $BrowserUrl
} else {
    Write-Host "[!] サーバーが ${maxWait} 秒以内に応答しませんでした。" -ForegroundColor Red
    Write-Host "    ブラウザを手動で開いてください: $BrowserUrl" -ForegroundColor Yellow
    # タイムアウトしてもブラウザは開こうとする
    Start-Process $BrowserUrl
}

# --- サーバーログをフォアグラウンドに表示 ---
Write-Host ""
Write-Host "サーバーログ (Ctrl+C で終了):" -ForegroundColor Cyan
Write-Host "-------------------------------------------------" -ForegroundColor DarkGray

try {
    while ($true) {
        $output = Receive-Job -Job $serverJob
        if ($output) { Write-Host $output }
        if ($serverJob.State -ne "Running") {
            Write-Host "[!] サーバーが予期せず停止しました。" -ForegroundColor Red
            break
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    Stop-Job -Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job -Job $serverJob -ErrorAction SilentlyContinue
    Write-Host "サーバーを停止しました。" -ForegroundColor Gray
}
