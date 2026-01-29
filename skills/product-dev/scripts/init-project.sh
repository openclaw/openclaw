#!/bin/bash
#
# Initialize a new project with PRD template
# Usage: ./init-project.sh <project-name> [path]
#
# Example:
#   ./init-project.sh my-saas-app
#   ./init-project.sh my-saas-app ~/projects
#

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get script directory (where the skill lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# Arguments
PROJECT_NAME="${1:-}"
BASE_PATH="${2:-.}"

if [ -z "$PROJECT_NAME" ]; then
    echo -e "${YELLOW}Usage: $0 <project-name> [path]${NC}"
    echo ""
    echo "Examples:"
    echo "  $0 my-saas-app"
    echo "  $0 my-saas-app ~/projects"
    exit 1
fi

# Normalize project name (lowercase, hyphens)
PROJECT_SLUG=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')

# Create project directory
PROJECT_PATH="$BASE_PATH/$PROJECT_SLUG"

if [ -d "$PROJECT_PATH" ]; then
    echo -e "${YELLOW}Warning: Directory $PROJECT_PATH already exists${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo -e "${BLUE}Creating project: $PROJECT_SLUG${NC}"
mkdir -p "$PROJECT_PATH"

# Copy PRD template
PRD_TEMPLATE="$SKILL_DIR/references/prd-template.md"
if [ -f "$PRD_TEMPLATE" ]; then
    cp "$PRD_TEMPLATE" "$PROJECT_PATH/PRD.md"
    echo -e "${GREEN}✓${NC} Created PRD.md from template"
else
    echo -e "${YELLOW}Warning: PRD template not found at $PRD_TEMPLATE${NC}"
    # Create minimal PRD
    cat > "$PROJECT_PATH/PRD.md" << 'EOF'
# [Project Name] - Product Requirements Document

**Version:** 1.0  
**Author:** [Your Name]  
**Date:** [Date]  
**Status:** Draft

---

## Executive Summary

### Vision
[What is this project and why does it need to exist?]

### Key Differentiators
1. [Differentiator 1]
2. [Differentiator 2]
3. [Differentiator 3]

---

## User Personas

### Primary Persona
- **Name:** [Name]
- **Role:** [Role]
- **Pain Points:** [What problems do they have?]
- **Goals:** [What do they want to achieve?]

---

## Feature Specification

## Phase 1: [Phase Name]

**Status:** 📋 Planned

### 1.1 [Feature Name]

**Priority:** P0  
**Status:** 📋 Planned

#### Description
[What does this feature do?]

#### Requirements
- [ ] Requirement 1
- [ ] Requirement 2

#### UI Mockup
```
[ASCII mockup here]
```

---

## Implementation Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1 | X weeks | None |

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| [Metric] | [Target] | [Method] |
EOF
    echo -e "${GREEN}✓${NC} Created minimal PRD.md"
fi

# Create standard directories
mkdir -p "$PROJECT_PATH/docs"
mkdir -p "$PROJECT_PATH/src"
echo -e "${GREEN}✓${NC} Created docs/ and src/ directories"

# Create .gitignore
cat > "$PROJECT_PATH/.gitignore" << 'EOF'
# Dependencies
node_modules/
vendor/
.venv/
__pycache__/

# Environment
.env
.env.local
.env.*.local

# Build
dist/
build/
*.egg-info/

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
logs/

# Temp
tmp/
.tmp/
EOF
echo -e "${GREEN}✓${NC} Created .gitignore"

# Create README
cat > "$PROJECT_PATH/README.md" << EOF
# $PROJECT_NAME

> [One-line description]

## Quick Start

\`\`\`bash
# TODO: Add setup instructions
\`\`\`

## Documentation

- [Product Requirements (PRD)](./PRD.md) - Full product specification

## Status

See [PRD.md](./PRD.md) for current implementation status.

---

*Created with product-dev skill*
EOF
echo -e "${GREEN}✓${NC} Created README.md"

echo ""
echo -e "${GREEN}Project initialized at: $PROJECT_PATH${NC}"
echo ""
echo "Next steps:"
echo "  1. cd $PROJECT_PATH"
echo "  2. Edit PRD.md - customize for your project"
echo "  3. git init && git add . && git commit -m 'Initial commit with PRD'"
echo "  4. Start building Phase 1!"
