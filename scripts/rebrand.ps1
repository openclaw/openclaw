# EasyHub Rebrand Script
# Replaces OpenClaw references with EasyHub

$rootPath = "C:\Users\KhaledBinSalman\Desktop\OS\easyhub"

# Exclude directories
$excludeDirs = @("node_modules", ".git", "dist", ".pnpm-store")

# File extensions to process
$extensions = @("*.ts", "*.tsx", "*.js", "*.mjs", "*.json", "*.md", "*.mdx", "*.yaml", "*.yml", "*.sh", "*.swift")

Write-Host "Starting EasyHub rebrand..." -ForegroundColor Cyan

# Get all files
$files = Get-ChildItem -Path $rootPath -Recurse -Include $extensions | Where-Object {
    $path = $_.FullName
    -not ($excludeDirs | Where-Object { $path -like "*\$_\*" })
}

Write-Host "Found $($files.Count) files to process" -ForegroundColor Yellow

$changedFiles = 0
$totalReplacements = 0

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    
    $original = $content
    
    # Replacements (order matters!)
    
    # 1. Config paths
    $content = $content -replace '\.openclaw-dev', '.easyhub-dev'
    $content = $content -replace '\.openclaw/', '.easyhub/'
    $content = $content -replace '\.openclaw\\', '.easyhub\'
    $content = $content -replace '\.openclaw"', '.easyhub"'
    $content = $content -replace "\.openclaw'", ".easyhub'"
    $content = $content -replace '\.openclaw`', '.easyhub`'
    
    # 2. Config file names
    $content = $content -replace 'openclaw\.json', 'easyhub.json'
    $content = $content -replace 'openclaw\.yaml', 'easyhub.yaml'
    $content = $content -replace 'openclaw\.log', 'easyhub.log'
    
    # 3. Environment variables (case sensitive)
    $content = $content -replace 'OPENCLAW_', 'EASYHUB_'
    $content = $content -replace 'CLAWDBOT_', 'EASYHUB_'
    
    # 4. CLI entry file
    $content = $content -replace 'openclaw\.mjs', 'easyhub.mjs'
    
    # 5. Package references
    $content = $content -replace '@openclaw/', '@easyhub/'
    
    # 6. Branding (careful with case)
    $content = $content -replace 'OpenClaw', 'EasyHub'
    $content = $content -replace 'openClaw', 'easyHub'
    $content = $content -replace 'OPENCLAW', 'EASYHUB'  # Already done by env vars but just in case
    
    # 7. CLI command references
    $content = $content -replace '(?<![a-zA-Z])openclaw(?![a-zA-Z])', 'easyhub'
    
    # 8. Remove docs.openclaw.ai links (replace with empty or placeholder)
    $content = $content -replace 'https://docs\.openclaw\.ai[^\s\)\]"''`]*', ''
    $content = $content -replace 'docs\.openclaw\.ai', ''
    
    # 9. Remove openclaw.ai references
    $content = $content -replace 'https://openclaw\.ai[^\s\)\]"''`]*', ''
    $content = $content -replace 'openclaw\.ai', 'easyhub.local'
    
    if ($content -ne $original) {
        Set-Content -Path $file.FullName -Value $content -NoNewline
        $changedFiles++
        # Count replacements (rough estimate)
        $replacements = ($original.Length - $content.Length)
        if ($replacements -lt 0) { $replacements = -$replacements }
        Write-Host "  Modified: $($file.FullName -replace [regex]::Escape($rootPath), '')" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Rebrand complete!" -ForegroundColor Cyan
Write-Host "Modified $changedFiles files" -ForegroundColor Yellow
