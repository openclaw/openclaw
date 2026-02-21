# deploy-check.ps1 — MAI Universe 배포 상태 점검
# Usage: powershell C:\MAIBOT\scripts\deploy-check.ps1

$projects = @(
    "C:\TEST\MAIOSS",
    "C:\TEST\MAIBEAUTY",
    "C:\TEST\MAIBOTALKS",
    "C:\TEST\MAITUTOR",
    "C:\TEST\MAITOK",
    "C:\TEST\MAISTAR7"
)

$results = @()

foreach ($dir in $projects) {
    $deployFile = Join-Path $dir "deploy.json"
    
    if (-not (Test-Path $deployFile)) {
        $results += [PSCustomObject]@{
            Project  = (Split-Path $dir -Leaf)
            Type     = "?"
            Platform = "?"
            URL      = "-"
            Status   = "NO deploy.json"
        }
        continue
    }

    $config = Get-Content $deployFile -Raw | ConvertFrom-Json
    $status = "OK"
    $url = if ($config.url) { $config.url } else { "-" }

    # Health check for web services
    if ($config.url) {
        try {
            $response = Invoke-WebRequest -Uri $config.url -Method HEAD -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            $status = "UP ($($response.StatusCode))"
        } catch {
            $status = "DOWN"
        }
    } else {
        $status = "N/A (no URL)"
    }

    # Check pre_deploy requirements
    $missingEnv = @()
    if ($config.env_required) {
        # Just note count for display
        $envCount = $config.env_required.Count
    }

    $results += [PSCustomObject]@{
        Project  = $config.project
        Type     = $config.type
        Platform = $config.platform
        URL      = $url
        Status   = $status
    }
}

Write-Host ""
Write-Host "=== MAI Universe Deploy Status ===" -ForegroundColor Cyan
Write-Host ""
$results | Format-Table -AutoSize
Write-Host "Checked at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
