#!/usr/bin/env pwsh
# Add multiple test targets to the harvester

$targets = @(
    "https://httpbin.org/uuid",
    "https://httpbin.org/user-agent",
    "https://httpbin.org/headers",
    "https://jsonplaceholder.typicode.com/posts/1",
    "https://jsonplaceholder.typicode.com/users/1",
    "https://api.github.com/zen"
)

Write-Host "➕ Adding $($targets.Count) test targets..." -ForegroundColor Cyan
Write-Host ""

foreach ($url in $targets) {
    try {
        $body = @{ url = $url } | ConvertTo-Json
        $response = Invoke-RestMethod -Uri "http://localhost:8080/api/targets" `
            -Method Post `
            -Body $body `
            -ContentType "application/json"

        Write-Host "✅ Added: $url" -ForegroundColor Green
    }
    catch {
        Write-Host "❌ Failed: $url - $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "✅ Done! Check http://localhost:5173 to see them in action!" -ForegroundColor Green
