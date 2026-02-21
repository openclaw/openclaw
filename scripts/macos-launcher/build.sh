#!/bin/bash
# Build OpenClaw.app launcher for macOS
# Usage: ./build.sh [output-path]
# Default output: ~/Desktop/OpenClaw.app

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT="${1:-$HOME/Desktop/OpenClaw.app}"

echo "Building OpenClaw.app..."

# Compile AppleScript to .app
osacompile -o "$OUTPUT" "$SCRIPT_DIR/OpenClaw.applescript"

# Copy icon if available
ICON_PATH="$REPO_ROOT/apps/macos/Sources/OpenClaw/Resources/OpenClaw.icns"
if [ -f "$ICON_PATH" ]; then
    cp "$ICON_PATH" "$OUTPUT/Contents/Resources/applet.icns"
    echo "Added OpenClaw icon"
fi

# Refresh icon cache
touch "$OUTPUT"

echo "Created: $OUTPUT"
echo ""
echo "To install: mv \"$OUTPUT\" /Applications/"
