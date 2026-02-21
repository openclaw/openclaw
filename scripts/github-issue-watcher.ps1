# GitHub Issue Watcher for MAISECONDBRAIN
# Polls GitHub every 60s for new issues, triggers MAIBOT heartbeat via /hooks/wake
# Run: powershell -File C:\MAIBOT\scripts\github-issue-watcher.ps1

$repo = "jini92/MAISECONDBRAIN"
$hookUrl = "http://127.0.0.1:18789/hooks/wake"
$hookToken = "mnemo-webhook-secret-2026"
$pollInterval = 60  # seconds
$stateFile = "$PSScriptRoot\.issue-watcher-state.json"

# Load last seen issue number
function Get-LastSeen {
    if (Test-Path $stateFile) {
        $state = Get-Content $stateFile | ConvertFrom-Json
        return $state.lastIssueNumber
    }
    return 0
}

function Set-LastSeen($number) {
    @{ lastIssueNumber = $number; updatedAt = (Get-Date -Format "o") } | ConvertTo-Json | Set-Content $stateFile
}

function Send-Wake($text) {
    try {
        $body = @{ text = $text; mode = "now" } | ConvertTo-Json
        $headers = @{ "Authorization" = "Bearer $hookToken"; "Content-Type" = "application/json" }
        Invoke-RestMethod -Uri $hookUrl -Method POST -Headers $headers -Body $body -TimeoutSec 10
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Wake sent: $text"
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Wake failed: $_"
    }
}

Write-Host "=== GitHub Issue Watcher ==="
Write-Host "Repo: $repo"
Write-Host "Poll interval: ${pollInterval}s"
Write-Host "State file: $stateFile"
Write-Host ""

$lastSeen = Get-LastSeen
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting. Last seen issue: #$lastSeen"

while ($true) {
    try {
        $issues = gh issue list -R $repo --state open --json number,title,createdAt,author --limit 10 2>&1 | ConvertFrom-Json
        
        if ($issues -and $issues.Count -gt 0) {
            $newIssues = $issues | Where-Object { $_.number -gt $lastSeen } | Sort-Object number
            
            foreach ($issue in $newIssues) {
                $author = $issue.author.login
                $msg = "[GitHub Issue] $repo #$($issue.number): $($issue.title) (by @$author)"
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] New issue detected: #$($issue.number) - $($issue.title)"
                Send-Wake $msg
                $lastSeen = $issue.number
                Set-LastSeen $lastSeen
            }
        }
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Poll error: $_"
    }
    
    Start-Sleep -Seconds $pollInterval
}
