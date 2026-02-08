#!/bin/bash
set -euo pipefail

# Script to push Android build workflow and trigger CI build
# This bypasses ARM64 Android SDK limitations

echo "🤖 Android Build Automation via GitHub Actions"
echo "================================================"
echo ""

# Check gh CLI
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) not found. Install it first:"
    echo "   curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg"
    echo "   sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg"
    echo "   echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null"
    echo "   sudo apt update"
    echo "   sudo apt install gh"
    exit 1
fi

# Check authentication
if ! gh auth status &> /dev/null; then
    echo "❌ Not authenticated with GitHub. Run:"
    echo "   gh auth login"
    exit 1
fi

echo "✅ GitHub CLI found and authenticated"
echo ""

# Check current branch
current_branch=$(git branch --show-current)
echo "📍 Current branch: $current_branch"
echo ""

# Check if workflow file exists
if [ ! -f .github/workflows/android-build.yml ]; then
    echo "❌ Workflow file not found: .github/workflows/android-build.yml"
    exit 1
fi

echo "✅ Workflow file exists"
echo ""

# Show git status
echo "📊 Git Status:"
git status --short
echo ""

# Commit changes if needed
if ! git diff --cached --quiet &> /dev/null; then
    echo "📝 Staged changes detected. Committing..."
    commit_message="Add GitHub Actions workflow for Android builds on ARM64

- Create .github/workflows/android-build.yml for CI builds
- Uses GitHub's x86-64 runners to bypass ARM64 SDK limitations
- Builds Debug and Release APKs automatically
- Uploads APKs as downloadable artifacts"
    
    git commit -m "$commit_message"
    echo "✅ Changes committed"
elif ! git diff --quiet &> /dev/null || ! git ls-files --others --exclude-standard | grep -q .; then
    echo "⚠️  Warning: Unstaged changes detected. Staging workflow files..."
    git add .github/workflows/android-build.yml .claude/cc10x/ ANDROID_BUILD_GUIDE.md
    
    commit_message="Add GitHub Actions workflow for Android builds on ARM64

- Create .github/workflows/android-build.yml for CI builds
- Uses GitHub's x86-64 runners to bypass ARM64 SDK limitations
- Builds Debug and Release APKs automatically
- Uploads APKs as downloadable artifacts"
    
    git commit -m "$commit_message"
    echo "✅ Changes committed"
else
    echo "ℹ️  Working directory clean or workflow already committed"
fi
echo ""

# Push changes
echo "🚀 Pushing changes to GitHub..."
git push origin "$current_branch"
echo "✅ Pushed successfully"
echo ""

# Trigger workflow manually (optional)
if [ "${AUTOMATIC_GITHUB_TRIGGER:-yes}" = "yes" ]; then
    echo "🎯 Triggering GitHub Actions workflow..."
    gh workflow run android-build.yml
    echo "✅ Workflow triggered"
    echo ""
    
    # Watch the workflow
    echo "⏳ Watching workflow execution... (Ctrl+C to stop)"
    sleep 5
    gh run watch --log --workflow=android-build.yml --interval=5
else
    echo "ℹ️  To trigger the workflow manually, run:"
    echo "   gh workflow run android-build.yml"
    echo ""
fi

echo ""
echo "✨ Done! Check GitHub Actions for build status."
echo "📱 Download APKs from: https://github.com/$GITHUB_REPOSITORY/actions"
