#!/bin/bash
# Sync enhancements from Clawdbot workspace to DNA
# Run this to pull in your latest changes

set -e

WORKSPACE="${CLAWD_WORKSPACE:-$HOME/clawd}"
DNA_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "🧬 DNA Sync"
echo "   From: $WORKSPACE"
echo "   To:   $DNA_DIR"
echo ""

# Sync skills (excluding personal ones)
echo "📦 Syncing skills..."
rsync -av --delete \
  --exclude='*.personal*' \
  --exclude='node_modules' \
  "$WORKSPACE/skills/" "$DNA_DIR/skills/"

# Sync IDE
echo "💻 Syncing IDE..."
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.db' \
  "$WORKSPACE/ide/" "$DNA_DIR/extensions/ide/"

# Sync knowledge system (structure only)
echo "🧠 Syncing knowledge structure..."
cp "$WORKSPACE/knowledge/PRD-BugDNA.md" "$DNA_DIR/knowledge/" 2>/dev/null || true
cp "$WORKSPACE/knowledge/WORKFLOW.md" "$DNA_DIR/knowledge/" 2>/dev/null || true

# Sync templates
echo "📋 Syncing templates..."
rsync -av "$WORKSPACE/templates/" "$DNA_DIR/templates/" 2>/dev/null || true

# Rename clawdbot -> dna
echo "🔄 Renaming references..."
find "$DNA_DIR/skills" "$DNA_DIR/extensions" -type f \( -name "*.md" -o -name "*.js" -o -name "*.json" \) \
  -exec sed -i '' \
    -e 's/clawdbot/dna/g' \
    -e 's/Clawdbot/DNA/g' \
    -e 's/CLAWDBOT/DNA/g' \
  {} + 2>/dev/null || true

# Rename skill directories
cd "$DNA_DIR/skills"
for dir in clawdbot-*; do
  if [ -d "$dir" ]; then
    newname=$(echo "$dir" | sed 's/clawdbot/dna/g')
    mv "$dir" "$newname" 2>/dev/null || true
  fi
done

echo ""
echo "✅ Sync complete!"
echo ""
echo "Next steps:"
echo "  cd $DNA_DIR"
echo "  git add -A"
echo "  git commit -m 'Sync from workspace'"
echo "  git push"
