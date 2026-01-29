#!/bin/bash
# Rename dna/dna -> dna throughout the codebase

cd "$(dirname "$0")"

echo "Renaming dna -> dna..."

# Rename in all text files (excluding .git and node_modules)
find . -type f \( -name "*.json" -o -name "*.js" -o -name "*.mjs" -o -name "*.ts" -o -name "*.md" -o -name "*.txt" -o -name "*.yaml" -o -name "*.yml" -o -name "*.sh" -o -name "*.swift" \) \
  -not -path "./.git/*" \
  -not -path "./node_modules/*" \
  -not -path "./dist/*" \
  -exec sed -i '' \
    -e 's/dna/dna/g' \
    -e 's/DNA/DNA/g' \
    -e 's/DNA/DNA/g' \
    -e 's/dna/dna/g' \
    -e 's/DNA/DNA/g' \
    -e 's/DNA/DNA/g' \
  {} +

# Rename files themselves
if [ -f "dna.mjs" ]; then
  mv dna.mjs dna.mjs
fi

echo "Done! Check package.json and key files."
