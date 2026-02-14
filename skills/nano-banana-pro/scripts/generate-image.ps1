<#
.SYNOPSIS
    Google Imagen 3 이미지 생성 스크립트
.DESCRIPTION
    Google Gemini API (Imagen 3)를 사용하여 텍스트 프롬프트로 이미지를 생성합니다.
.EXAMPLE
    .\generate-image.ps1 -Prompt "A sleek cosmetics bottle on white background"
    .\generate-image.ps1 -Prompt "Korean skincare product" -Count 2 -AspectRatio "4:3"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Prompt,

    [string]$OutputDir = "C:\TEST\generated-images",

    [ValidateRange(1, 4)]
    [int]$Count = 1,

    [ValidateSet("1:1", "3:4", "4:3", "9:16", "16:9")]
    [string]$AspectRatio = "1:1",

    [string]$Model = "imagen-4.0-fast-generate-001"
)

$ErrorActionPreference = "Stop"

# --- Load API key ---
$configPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"
if (-not (Test-Path $configPath)) {
    Write-Error "Config not found: $configPath"
    exit 1
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$apiKey = $config.models.providers.google.apiKey

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Error "Google API key not found in openclaw.json (models.providers.google.apiKey)"
    exit 1
}

# --- Ensure output directory ---
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# --- Build request ---
$uri = "https://generativelanguage.googleapis.com/v1beta/models/${Model}:predict"

$body = @{
    instances = @(
        @{ prompt = $Prompt }
    )
    parameters = @{
        sampleCount = $Count
        aspectRatio = $AspectRatio
    }
} | ConvertTo-Json -Depth 5

$headers = @{
    "x-goog-api-key" = $apiKey
    "Content-Type"   = "application/json"
}

# --- Call API ---
Write-Host "[Nano Banana Pro] Generating $Count image(s)..." -ForegroundColor Cyan
Write-Host "  Prompt: $Prompt"
Write-Host "  Aspect: $AspectRatio | Model: $Model"

try {
    $response = Invoke-RestMethod -Uri $uri -Method POST -Headers $headers -Body $body -TimeoutSec 120
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    $errBody = ""
    try {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $errBody = $reader.ReadToEnd()
    } catch {}

    Write-Error "API request failed (HTTP $statusCode): $errBody"
    exit 1
}

# --- Save images ---
$savedFiles = @()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

if (-not $response.predictions) {
    Write-Error "No predictions in response. Response: $($response | ConvertTo-Json -Depth 5)"
    exit 1
}

$index = 0
foreach ($prediction in $response.predictions) {
    $index++
    $b64 = $prediction.bytesBase64Encoded
    if ([string]::IsNullOrWhiteSpace($b64)) {
        Write-Warning "Prediction $index has no image data (may have been filtered by safety)"
        continue
    }

    $filename = "imagen_${timestamp}_${index}.png"
    $filePath = Join-Path $OutputDir $filename
    $bytes = [Convert]::FromBase64String($b64)
    [IO.File]::WriteAllBytes($filePath, $bytes)
    $savedFiles += $filePath
    Write-Host "  Saved: $filePath" -ForegroundColor Green
}

if ($savedFiles.Count -eq 0) {
    Write-Error "No images were generated (all may have been safety-filtered)"
    exit 1
}

# --- Output result ---
Write-Host "`n[Done] Generated $($savedFiles.Count) image(s):" -ForegroundColor Cyan
$savedFiles | ForEach-Object { Write-Host "  $_" }

# Return file paths for programmatic use
return $savedFiles
