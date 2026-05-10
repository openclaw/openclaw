#!/usr/bin/env pwsh
# 🔐 ALPHABET HARVESTER - Authenticated restart helper

$repoRoot = $PSScriptRoot
$serviceName = "alpacore"
$statusUrl = "http://localhost:8080/api/github/status"

Write-Host "🔐 Re-authenticating ALPHABET HARVESTER via GitHub CLI..." -ForegroundColor Green
Write-Host ""

Set-Location $repoRoot

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
    Write-Host "❌ GitHub CLI (gh) fannst ekki á vélinni" -ForegroundColor Red
    exit 1
}

try {
    $token = gh auth token
}
catch {
    Write-Host "❌ Gat ekki sótt token frá gh auth" -ForegroundColor Red
    Write-Host "   Keyrðu: gh auth login" -ForegroundColor Yellow
    exit 1
}

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host "❌ gh auth token skilaði tómu gildi" -ForegroundColor Red
    exit 1
}

$previousToken = [Environment]::GetEnvironmentVariable("HARVESTER_GITHUB_TOKEN", "Process")

try {
    $env:HARVESTER_GITHUB_TOKEN = $token

    Write-Host "📦 Recreate-a $serviceName með GitHub token..." -ForegroundColor Cyan
    docker-compose up -d --force-recreate $serviceName
    if ($LASTEXITCODE -ne 0) {
        throw "docker-compose recreate mistókst"
    }

    $status = $null
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            $status = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 5
            if ($status) {
                break
            }
        }
        catch {
            Start-Sleep -Seconds 2
        }
    }

    if (-not $status) {
        throw "Backend svaraði ekki /api/github/status í tæka tíð"
    }

    Write-Host ""
    Write-Host "✅ Auth restart lokið" -ForegroundColor Green
    Write-Host "   Mode:      $($status.authMode)" -ForegroundColor Cyan
    Write-Host "   Token:     $($status.tokenPresent)" -ForegroundColor Cyan

    if ($status.rateLimit) {
        Write-Host "   Rate left: $($status.rateLimit.remaining)/$($status.rateLimit.limit)" -ForegroundColor Green
    }
    else {
        Write-Host "   Rate left: ekki komið enn" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "🌐 UI: http://localhost:5173" -ForegroundColor Magenta
    Write-Host "🔎 API: $statusUrl" -ForegroundColor Magenta
}
catch {
    Write-Host "❌ $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if ([string]::IsNullOrWhiteSpace($previousToken)) {
        Remove-Item Env:HARVESTER_GITHUB_TOKEN -ErrorAction SilentlyContinue
    }
    else {
        $env:HARVESTER_GITHUB_TOKEN = $previousToken
    }

    $token = $null
}
