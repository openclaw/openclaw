#!/bin/bash
# OpenCode GitHub Workflow Script
# Manages GitHub repository creation and commits for OpenCode projects

set -e

# Check for active project
if [ ! -f /tmp/opencode_current_project.txt ]; then
    echo "Error: No active OpenCode project found"
    echo "Run init_project.sh first to create a project"
    exit 1
fi

PROJECT_NAME=$(cat /tmp/opencode_current_project.txt)
REPO_NAME=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g')

# Default commit message
COMMIT_MSG="${2:-"Initial commit: $PROJECT_NAME"}"

case "$1" in
    init)
        echo "Initializing Git repository for: $PROJECT_NAME"
        
        # Check if git is installed
        if ! command -v git &> /dev/null; then
            echo "Error: git is not installed"
            exit 1
        fi
        
        # Initialize git repository
        git init
        git add .
        git commit -m "$COMMIT_MSG"
        
        echo "✓ Git repository initialized"
        echo "✓ Changes committed: $COMMIT_MSG"
        ;;
        
    create-repo)
        echo "Creating GitHub repository: $REPO_NAME"
        
        # Check if gh CLI is installed
        if ! command -v gh &> /dev/null; then
            echo "Error: GitHub CLI (gh) is not installed"
            echo "Install from: https://cli.github.com/"
            exit 1
        fi
        
        # Check if authenticated
        if ! gh auth status &> /dev/null; then
            echo "Error: Not authenticated with GitHub CLI"
            echo "Run: gh auth login"
            exit 1
        fi
        
        # Create repository (using SSH)
        gh repo create "$REPO_NAME" --public --source=. --remote=origin --push --clone
        
        echo "✓ GitHub repository created: https://github.com/$(gh api user | jq -r '.login')/$REPO_NAME"
        ;;
        
    commit)
        if [ -z "$2" ]; then
            echo "Usage: $0 commit \"<commit message>\""
            echo "Example: $0 commit \"feat: add user authentication\""
            exit 1
        fi
        
        echo "Committing changes: $COMMIT_MSG"
        
        # Check if in git repository
        if ! git rev-parse --git-dir > /dev/null 2>&1; then
            echo "Error: Not in a git repository"
            echo "Run '$0 init' first"
            exit 1
        fi
        
        # Stage all changes
        git add .
        
        # Commit
        git commit -m "$COMMIT_MSG"
        
        echo "✓ Changes committed: $COMMIT_MSG"
        
        # Push if remote exists
        if git remote | grep -q origin; then
            git push origin HEAD
            echo "✓ Changes pushed to remote"
        else
            echo "⚠ No remote configured. Add remote with: git remote add origin <url>"
        fi
        ;;
        
    push)
        echo "Pushing changes to remote..."
        
        # Check if in git repository
        if ! git rev-parse --git-dir > /dev/null 2>&1; then
            echo "Error: Not in a git repository"
            exit 1
        fi
        
        # Check if remote exists
        if ! git remote | grep -q origin; then
            echo "Error: No remote 'origin' configured"
            echo "Add remote with: git remote add origin <url>"
            exit 1
        fi
        
        # Push to remote
        git push origin HEAD
        
        echo "✓ Changes pushed to remote"
        ;;
        
    status)
        echo "Project: $PROJECT_NAME"
        echo "Repository: $REPO_NAME"
        echo ""
        
        # Git status
        if git rev-parse --git-dir > /dev/null 2>&1; then
            echo "Git Status:"
            git status --short
            echo ""
            
            # Remote info
            if git remote | grep -q origin; then
                REMOTE_URL=$(git remote get-url origin)
                echo "Remote: $REMOTE_URL"
            else
                echo "Remote: Not configured"
            fi
        else
            echo "Git: Not initialized"
        fi
        ;;
        
    *)
        echo "OpenCode GitHub Workflow"
        echo ""
        echo "Usage: $0 <command> [options]"
        echo ""
        echo "Commands:"
        echo "  init [message]      Initialize git repository and commit"
        echo "  create-repo         Create GitHub repository and push"
        echo "  commit \"message\"    Commit changes with message"
        echo "  push               Push changes to remote"
        echo "  status             Show project and git status"
        echo ""
        echo "Examples:"
        echo "  $0 init \"Initial commit: Todo App\""
        echo "  $0 create-repo"
        echo "  $0 commit \"feat: add user authentication\""
        echo "  $0 push"
        exit 1
        ;;
esac