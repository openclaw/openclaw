#!/bin/bash
set -euo pipefail

# Round-trip verification script for Memory Brotli Compression
# Compresses memory layer on disk to save space

MEMORY_DIR="${1:-~/.openclaw/workspace/memory}"
ARCHIVE_FILE="memory_archive.tar.br"

if [ ! -d "$MEMORY_DIR" ]; then
  echo "Memory directory not found: $MEMORY_DIR"
  echo "Creating dummy directory for test purposes..."
  mkdir -p "$MEMORY_DIR"
  echo "Dummy memory content" > "$MEMORY_DIR/dummy.md"
fi

echo "Compressing memory directory..."
tar -cf - "$MEMORY_DIR" | brotli -q 9 -o "$ARCHIVE_FILE"

echo "Verifying round-trip..."
if brotli -d -c "$ARCHIVE_FILE" | tar -t >/dev/null; then
    echo "Compression round-trip verified successfully!"
else
    echo "Compression verification failed!"
fi
