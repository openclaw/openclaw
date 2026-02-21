# GitHub Watcher — Issues + PR Reviews
# Polls GitHub every 60s, triggers MAIBOT heartbeat via /hooks/wake
# Run: powershell -File C:\MAIBOT\scripts\github-watcher.ps1

$hookUrl = "http://127.0.0.1:18789/hooks/wake"
$hookToken = "mnemo-webhook-secret-2026"
$pollInterval = 60  # seconds
$stateFile = "$PSScriptRoot\.github-watcher-state.json"

# === State ===
function Get-State {
    if (Test-Path $stateFile) {
        return Get-Content $stateFile -Raw | ConvertFrom-Json
    }
    return @{ lastIssueNumber = 0; prCommentCounts = @{}; updatedAt = "" }
}

function Save-State($state) {
    $state | ConvertTo-Json -Depth 3 | Set-Content $stateFile
}

function Send-Wake($text) {
    try {
        $body = @{ text = $text; mode = "now" } | ConvertTo-Json -Depth 2
        $headers = @{ "Authorization" = "Bearer $hookToken"; "Content-Type" = "application/json" }
        Invoke-RestMethod -Uri $hookUrl -Method POST -Headers $headers -Body $body -TimeoutSec 10 | Out-Null
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Wake: $text"
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Wake failed: $_"
    }
}

Write-Host "=== GitHub Watcher (Issues + PR Reviews) ==="
Write-Host "Poll interval: ${pollInterval}s"
Write-Host ""

$state = Get-State
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Last issue: #$($state.lastIssueNumber)"

# === Tracked PRs ===
$trackedPRs = @(
    @{ repo = "obsidianmd/obsidian-releases"; number = 10404; label = "Obsidian Plugin PR" }
    # 추가 PR 추적은 여기에
)

while ($true) {
    # --- 1. MAISECONDBRAIN Issues ---
    try {
        $issues = gh issue list -R "jini92/MAISECONDBRAIN" --state open --json number,title,author --limit 10 2>&1 | ConvertFrom-Json
        if ($issues -and $issues.Count -gt 0) {
            $newIssues = $issues | Where-Object { $_.number -gt $state.lastIssueNumber } | Sort-Object number
            foreach ($issue in $newIssues) {
                Send-Wake "[GitHub Issue] jini92/MAISECONDBRAIN #$($issue.number): $($issue.title) (by @$($issue.author.login))"
                $state.lastIssueNumber = $issue.number
            }
        }
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Issue poll error: $_"
    }

    # --- 2. Tracked PR Reviews/Comments ---
    foreach ($pr in $trackedPRs) {
        try {
            $comments = gh pr view $pr.number -R $pr.repo --json comments,reviews --jq '(.comments | length) + (.reviews | length)' 2>&1
            $count = [int]$comments

            $key = "$($pr.repo)#$($pr.number)"
            $prev = 0
            if ($state.prCommentCounts.PSObject.Properties.Name -contains $key) {
                $prev = $state.prCommentCounts.$key
            }

            if ($count -gt $prev) {
                $diff = $count - $prev
                Send-Wake "[PR Review] $($pr.label) ($key): $diff new comment(s)/review(s)"
                if (-not $state.prCommentCounts) { $state.prCommentCounts = @{} }
                $state.prCommentCounts | Add-Member -NotePropertyName $key -NotePropertyValue $count -Force
            }
        } catch {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] PR poll error ($($pr.repo)#$($pr.number)): $_"
        }
    }

    # Save state
    $state.updatedAt = (Get-Date -Format "o")
    Save-State $state

    Start-Sleep -Seconds $pollInterval
}
