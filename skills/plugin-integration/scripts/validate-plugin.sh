#!/bin/bash

# Validate plugin structure and metadata for OpenClaw plugins
# OpenClaw plugins use openclaw.plugin.json, not manifest.json

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <plugin-directory>"
  echo "Example: $0 ~/.openclaw/plugins/my-plugin"
  exit 1
fi

PLUGIN_DIR="$1"

if [ ! -d "$PLUGIN_DIR" ]; then
  echo "Error: Directory $PLUGIN_DIR does not exist."
  exit 1
fi

PLUGIN_NAME=$(basename "$PLUGIN_DIR")
echo "🔍 Validating plugin: $PLUGIN_NAME"
echo ""

# Check for openclaw.plugin.json (the correct manifest file for OpenClaw plugins)
MANIFEST_FILE="$PLUGIN_DIR/openclaw.plugin.json"
if [ ! -f "$MANIFEST_FILE" ]; then
  echo "❌ Error: openclaw.plugin.json not found in $PLUGIN_DIR"
  echo "   OpenClaw plugins require an openclaw.plugin.json manifest file."
  echo ""
  echo "Example manifest structure:"
  echo '{'
  echo '  "name": "my-plugin",'
  echo '  "version": "1.0.0",'
  echo '  "description": "My awesome plugin",'
  echo '  "main": "index.js",'
  echo '  "author": "Your Name"'
  echo '}'
  exit 1
fi

# Validate JSON syntax
if ! jq empty "$MANIFEST_FILE" 2>/dev/null; then
  echo "❌ Error: openclaw.plugin.json is not valid JSON."
  echo "   Run: jq . $MANIFEST_FILE"
  exit 1
fi

echo "✅ Manifest file is valid JSON"

# Check for required fields
REQUIRED_FIELDS=("name" "version")
MISSING_FIELDS=()

for field in "${REQUIRED_FIELDS[@]}"; do
  if [ "$(jq -r "has(\"$field\")" "$MANIFEST_FILE")" != "true" ]; then
    MISSING_FIELDS+=("$field")
  fi
done

if [ ${#MISSING_FIELDS[@]} -gt 0 ]; then
  echo "❌ Error: Missing required fields: ${MISSING_FIELDS[*]}"
  exit 1
fi

echo "✅ Required fields present: name, version"

# Check for main file if specified
MAIN_FILE=$(jq -r '.main // "index.js"' "$MANIFEST_FILE")
if [ -n "$MAIN_FILE" ] && [ "$MAIN_FILE" != "null" ]; then
  if [ ! -f "$PLUGIN_DIR/$MAIN_FILE" ]; then
    echo "⚠️  Warning: Main file '$MAIN_FILE' not found in $PLUGIN_DIR"
    echo "   The plugin may not load correctly."
  else
    echo "✅ Main file found: $MAIN_FILE"
  fi
fi

# Display plugin info
echo ""
echo "📋 Plugin Information:"
echo "   Name: $(jq -r '.name' "$MANIFEST_FILE")"
echo "   Version: $(jq -r '.version' "$MANIFEST_FILE")"
DESCRIPTION=$(jq -r '.description // "No description"' "$MANIFEST_FILE")
echo "   Description: $DESCRIPTION"

# Check for optional but recommended files
RECOMMENDED_FILES=("README.md" "LICENSE")
for file in "${RECOMMENDED_FILES[@]}"; do
  if [ -f "$PLUGIN_DIR/$file" ]; then
    echo "   ✅ Has $file"
  else
    echo "   ⚠️  Missing $file (recommended)"
  fi
done

echo ""
echo "✅ Plugin validation successful!"
echo "   Plugin appears ready for installation."