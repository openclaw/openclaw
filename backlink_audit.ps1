Set-Location d:\openclaw_bot\openclaw_bot
$targets = @("BRAIN","MEMORY","SOUL","IDENTITY","HEARTBEAT","PROJECT_CONTEXT","MOC","VISION","LearnLM","Gemini","CHANGELOG","TROUBLESHOOTING")
foreach ($t in $targets) {
    $hits = Select-String -Path "*.md" -Pattern "\[\[$t\]\]" -SimpleMatch -ErrorAction SilentlyContinue
    $count = if ($hits) { $hits.Count } else { 0 }
    $sources = if ($hits) { ($hits | ForEach-Object { $_.Filename } | Sort-Object -Unique) -join ", " } else { "none" }
    Write-Host "${t}: ${count} backlinks from: ${sources}"
}
