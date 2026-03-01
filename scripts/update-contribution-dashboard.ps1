param([switch]$Quiet)

$ErrorActionPreference = "SilentlyContinue"
$VaultPath     = "C:\Users\jini9\OneDrive\Documents\JINI_SYNC"
$Dashboard     = "$VaultPath\01.PROJECT\00.MAIBOT\_CONTRIBUTION_DASHBOARD.md"
$MainDashboard = "$VaultPath\TEMPLATES\Dashboard.md"
$ContribMem = "C:\MAIBOT\memory\contributions.md"
$RevMem     = "C:\MAIBOT\memory\revenue-tracker.md"
$Today      = Get-Date -Format "yyyy-MM-dd"
$Now        = Get-Date -Format "yyyy-MM-dd HH:mm"

# --- 1. GitHub PR collection ---
$ghContribs = @()
$trackedRepos = @(
    "openclaw/openclaw",
    "obsidianmd/obsidian-releases",
    "jini92/MAISECONDBRAIN",
    "jini92/MAIOSS",
    "jini92/MAIBOTALKS",
    "jini92/MAITOK",
    "jini92/MAITUTOR",
    "jini92/MAICON"
)
foreach ($repo in $trackedRepos) {
    try {
        $prs = gh pr list --repo $repo --author jini92 --state all --json number,title,state,mergedAt,url --limit 20 2>$null | ConvertFrom-Json
        foreach ($pr in $prs) {
            $type  = if ($pr.state -eq "MERGED") { "OSS_PR_MERGED" } else { "OSS_PR_OPEN" }
            $score = if ($pr.state -eq "MERGED") { 10 } else { 3 }
            $date  = if ($pr.mergedAt) { $pr.mergedAt.Substring(0,10) } else { $Today }
            $ghContribs += [PSCustomObject]@{
                Date  = $date; Project = $repo; Type = $type
                Title = ($pr.title -replace "\|","-"); Url = $pr.url; Score = $score
            }
        }
    } catch {}
}

# --- 2. Parse manual contributions.md ---
$manualContribs = @()
if (Test-Path $ContribMem) {
    $pat = "^\| \d{4}-\d{2}-\d{2}"
    foreach ($line in (Get-Content $ContribMem)) {
        if ($line -match $pat) {
            $cols = ($line -split "\|") | Where-Object { $_.Trim() -ne "" } | ForEach-Object { $_.Trim() }
            if ($cols.Count -ge 6) {
                $manualContribs += [PSCustomObject]@{
                    Date  = $cols[0]; Project = $cols[1]; Type = $cols[2]
                    Title = $cols[3]; Url = $cols[4]; Score = [int]($cols[5] -replace "[^0-9]","0")
                }
            }
        }
    }
}

# --- 3. Merge & dedupe by URL ---
$allContribs = @()
$seen = @{}
foreach ($c in ($ghContribs + $manualContribs)) {
    if ($c.Url -and -not $seen[$c.Url]) {
        $seen[$c.Url] = $true
        $allContribs += $c
    }
}
$allContribs = $allContribs | Sort-Object Date -Descending

# --- 4. Parse revenue-tracker.md ---
$revenueByMonth = @{}
if (Test-Path $RevMem) {
    $revPat = "^\| \d{4}-\d{2}"
    foreach ($line in (Get-Content $RevMem)) {
        if ($line -match $revPat) {
            $cols = ($line -split "\|") | Where-Object { $_.Trim() -ne "" } | ForEach-Object { $_.Trim() }
            if ($cols.Count -ge 2) {
                $month = $cols[0]
                $total = 0
                for ($i = 1; $i -lt ($cols.Count - 1); $i++) {
                    $v = $cols[$i] -replace "[^0-9]",""
                    if ($v.Length -gt 0) { $total += [int]$v }
                }
                $revenueByMonth[$month] = $total
            }
        }
    }
}

# --- 5. Monthly aggregation ---
$contribByMonth = @{}
foreach ($c in $allContribs) {
    $m = $c.Date.Substring(0,7)
    if (-not $contribByMonth[$m]) { $contribByMonth[$m] = @{ count=0; score=0 } }
    $contribByMonth[$m].count++
    $contribByMonth[$m].score += $c.Score
}

$months = @()
for ($i = 5; $i -ge 0; $i--) { $months += (Get-Date).AddMonths(-$i).ToString("yyyy-MM") }

$lbl = ($months | ForEach-Object { "`"" + $_.Substring(5) + "`"" }) -join ", "
$pts = ($months | ForEach-Object { if ($contribByMonth[$_]) { $contribByMonth[$_].score } else { 0 } }) -join ", "
$rev = ($months | ForEach-Object { if ($revenueByMonth[$_]) { [math]::Round($revenueByMonth[$_]/10000) } else { 0 } }) -join ", "

$totalScore   = if ($allContribs) { ($allContribs | Measure-Object Score -Sum).Sum } else { 0 }
$totalContrib = $allContribs.Count
$mergedCount  = ($allContribs | Where-Object { $_.Type -eq "OSS_PR_MERGED" }).Count
$openCount    = ($allContribs | Where-Object { $_.Type -eq "OSS_PR_OPEN" }).Count

# --- 6. Recent contributions table ---
$rows = ($allContribs | Select-Object -First 10) | ForEach-Object {
    $e = switch ($_.Type) {
        "OSS_PR_MERGED"   { "OK" }; "OSS_PR_OPEN" { "PR" }
        "SKILL_PUBLISHED" { "PKG" }; "BLOG_POST"  { "PEN" }
        default           { "ST" }
    }
    "| $($_.Date) | $($_.Project) | $e $($_.Type) | [$($_.Title)]($($_.Url)) | +$($_.Score) |"
}
$recentTable = $rows -join "`n"

# --- 7. Write dashboard ---
$md = @"
---
tags:
  - dashboard
  - contribution
  - monetization
  - mai-universe
updated: $Today
---

# MAI Universe — Contribution & Monetization Dashboard

> MAI Universe: 기여할수록 강해지고, 수익화할수록 지속된다.
> Last updated: $Now (auto by MAIBOT heartbeat)

---

## Summary

| Item | Value |
|------|-------|
| Total Contribution Score | **$totalScore pt** |
| Total Contributions | $totalContrib |
| PR Merged | $mergedCount |
| PR Open | $openCount |
| This Month MRR | KRW 0 (pre-revenue) |

---

## Monthly Contribution Score

``````mermaid
xychart-beta
    title "Contribution Score (pt)"
    x-axis [$lbl]
    y-axis "score" 0 --> 50
    bar [$pts]
``````

---

## Monthly Monetization (unit: 10k KRW)

``````mermaid
xychart-beta
    title "Monetization (10k KRW)"
    x-axis [$lbl]
    y-axis "10k KRW" 0 --> 100
    bar [$rev]
``````

---

## Contribution vs Monetization Matrix

``````mermaid
quadrantChart
    title Contribution-Revenue Positioning
    x-axis "Low Revenue" --> "High Revenue"
    y-axis "Low Contribution" --> "High Contribution"
    quadrant-1 Golden Zone
    quadrant-2 Contribution-led
    quadrant-3 Early Stage
    quadrant-4 Revenue-led
    MAIBOT: [0.15, 0.75]
    MAIBOTALKS: [0.25, 0.30]
    MAIOSS: [0.20, 0.45]
    MAISECONDBRAIN: [0.30, 0.50]
    MAIBEAUTY: [0.35, 0.25]
    MAITOK: [0.10, 0.15]
    MAITUTOR: [0.10, 0.20]
``````

---

## Recent Contributions

| Date | Project | Type | Title | Score |
|------|---------|------|-------|-------|
$recentTable

---

## Monetization Status

| Project | Model | Status | MRR |
|---------|-------|--------|-----|
| MAIBOTALKS | App Subscription | Review | - |
| MAIOSS | B2B SaaS | Building | - |
| MAIBEAUTY | AI Sales | Building | - |
| MAITUTOR | Freemium | Planning | - |
| MAITOK | Ads/Sub | Planning | - |
| MAICON | Booking | Planning | - |

---

*Auto-generated by MAIBOT: C:\MAIBOT\scripts\update-contribution-dashboard.ps1*
"@

$md | Set-Content -Path $Dashboard -Encoding UTF8
Write-Host "Dashboard updated: $Dashboard"
Write-Host "Score: ${totalScore}pt | Contribs: ${totalContrib} | Merged: ${mergedCount}"

# --- 8. Sync to TEMPLATES/Dashboard.md (AUTO block at top) ---
$miniBlock = @"
<!-- AUTO:contribution-dashboard:START -->
> **Last updated:** $Now

| Total Score | Contributions | PR Merged | PR Open | MRR |
|-------------|---------------|-----------|---------|-----|
| **${totalScore} pt** | $totalContrib | $mergedCount | $openCount | KRW 0 |

``````mermaid
xychart-beta
    title "Contribution (bar, pt) vs Monetization (line, 10k KRW)"
    x-axis [$lbl]
    y-axis "value" 0 --> 50
    bar [$pts]
    line [$rev]
``````
<!-- AUTO:contribution-dashboard:END -->
"@

if (Test-Path $MainDashboard) {
    $raw = [System.IO.File]::ReadAllText($MainDashboard, [System.Text.Encoding]::UTF8)
    if ($raw -match "<!-- AUTO:contribution-dashboard:START -->") {
        $escaped = [regex]::Escape("<!-- AUTO:contribution-dashboard:START -->")
        $raw = $raw -replace "(?s)<!-- AUTO:contribution-dashboard:START -->.*?<!-- AUTO:contribution-dashboard:END -->", $miniBlock
        [System.IO.File]::WriteAllText($MainDashboard, $raw, [System.Text.Encoding]::UTF8)
        Write-Host "Main Dashboard synced: $MainDashboard"
    }
}
