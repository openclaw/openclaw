# KPI Collector - MAI Universe GitHub Metrics
# Collects GitHub-based contribution metrics for all MAI projects
# Usage: .\kpi-collector.ps1 [-OutputJson <path>]

param(
    [string]$OutputJson = ""
)

$repos = @(
    "MAIBOT", "MAIBEAUTY", "MAIOSS", "MAITUTOR",
    "MAIBOTALKS", "MAITOK", "MAIAX", "MAISECONDBRAIN"
)
$owner = "jini92"
$since = (Get-Date).AddDays(-30).ToString("yyyy-MM-ddTHH:mm:ssZ")
$results = @()

foreach ($repo in $repos) {
    Write-Host "Collecting: $owner/$repo ..." -ForegroundColor Cyan
    
    # Basic repo info
    $info = gh api "repos/$owner/$repo" 2>$null | ConvertFrom-Json
    if (-not $info) {
        Write-Host "  SKIP: repo not found or no access" -ForegroundColor Yellow
        $results += @{
            project = $repo; stars = 0; forks = 0; open_issues = 0
            commits_30d = 0; contributors = 0; last_activity = "N/A"
            error = "not found"
        }
        continue
    }
    
    $stars = $info.stargazers_count
    $forks = $info.forks_count
    $openIssues = $info.open_issues_count
    $lastPush = if ($info.pushed_at) { (Get-Date $info.pushed_at).ToString("yyyy-MM-dd") } else { "N/A" }
    
    # Commits in last 30 days
    $commits30d = 0
    try {
        $commitsData = gh api "repos/$owner/$repo/commits?since=$since&per_page=100" 2>$null | ConvertFrom-Json
        if ($commitsData) { $commits30d = $commitsData.Count }
    } catch {}
    
    # Contributors count
    $contribs = 0
    try {
        $contribData = gh api "repos/$owner/$repo/contributors?per_page=100" 2>$null | ConvertFrom-Json
        if ($contribData) { $contribs = $contribData.Count }
    } catch {}
    
    $entry = @{
        project       = $repo
        stars         = $stars
        forks         = $forks
        open_issues   = $openIssues
        commits_30d   = $commits30d
        contributors  = $contribs
        last_activity = $lastPush
    }
    $results += $entry
    
    Write-Host "  Stars=$stars Forks=$forks Issues=$openIssues Commits(30d)=$commits30d Last=$lastPush"
}

# Output
$output = @{
    collected_at = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    metrics      = $results
}

if ($OutputJson) {
    $dir = Split-Path $OutputJson -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = $output | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($OutputJson, $json, [System.Text.UTF8Encoding]::new($false))
    Write-Host "`nSaved to: $OutputJson" -ForegroundColor Green
}

# Return object for pipeline use
$output | ConvertTo-Json -Depth 5
