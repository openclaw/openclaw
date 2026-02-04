# Sync with upstream OpenClaw repository
# Run this script to pull latest updates from the original project

param(
    [switch]$Merge,    # Use merge instead of rebase
    [switch]$Force,    # Force sync (will overwrite local changes)
    [string]$Branch = "main"  # Branch to sync from
)

$ErrorActionPreference = "Stop"

Write-Host "🔄 Syncing with upstream OpenClaw..." -ForegroundColor Cyan

# Fetch latest from upstream
Write-Host "`n📥 Fetching from upstream..." -ForegroundColor Yellow
git fetch upstream

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Failed to fetch from upstream" -ForegroundColor Red
    exit 1
}

# Check for uncommitted changes
$status = git status --porcelain
if ($status -and -not $Force) {
    Write-Host "⚠️  You have uncommitted changes. Commit or stash them first." -ForegroundColor Yellow
    Write-Host "   Or use -Force to discard local changes." -ForegroundColor Yellow
    git status --short
    exit 1
}

# Get current branch
$currentBranch = git rev-parse --abbrev-ref HEAD

Write-Host "`n🔀 Current branch: $currentBranch" -ForegroundColor Green

if ($Force) {
    Write-Host "⚠️  Force mode: Resetting to upstream/$Branch" -ForegroundColor Yellow
    git reset --hard upstream/$Branch
} elseif ($Merge) {
    Write-Host "🔀 Merging upstream/$Branch into $currentBranch..." -ForegroundColor Yellow
    git merge upstream/$Branch --no-edit
} else {
    Write-Host "🔀 Rebasing $currentBranch onto upstream/$Branch..." -ForegroundColor Yellow
    git rebase upstream/$Branch
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ Sync failed. You may need to resolve conflicts." -ForegroundColor Red
    Write-Host "   Run 'git status' to see conflicts." -ForegroundColor Yellow
    Write-Host "   After resolving, run 'git rebase --continue' or 'git merge --continue'" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n✅ Sync complete!" -ForegroundColor Green

# Show what changed
Write-Host "`n📋 Recent upstream changes:" -ForegroundColor Cyan
git log --oneline -10 upstream/$Branch

Write-Host "`n💡 Tips:" -ForegroundColor Cyan
Write-Host "   - Run 'pnpm install' if dependencies changed" -ForegroundColor Gray
Write-Host "   - Run 'pnpm build' to rebuild" -ForegroundColor Gray
Write-Host "   - Check CHANGELOG.md for breaking changes" -ForegroundColor Gray
