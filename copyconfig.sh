#!/usr/bin/env bash
set -euo pipefail

SOURCE="${HOME}/openclaw/openclaw.json"
TARGET="${HOME}/.openclaw/openclaw.json"

# Check if source file exists
if [[ ! -f "${SOURCE}" ]]; then
    echo "Error: Source file not found: ${SOURCE}"
    exit 1
fi

# Create backup of existing config if it exists
if [[ -f "${TARGET}" ]]; then
    BACKUP="${TARGET}.backup.$(date +%Y%m%d-%H%M%S)"
    echo "Creating backup: ${BACKUP}"
    cp "${TARGET}" "${BACKUP}"
fi

# Ensure target directory exists
mkdir -p "$(dirname "${TARGET}")"

# Copy the file
echo "Copying ${SOURCE} to ${TARGET}"
cp "${SOURCE}" "${TARGET}"

echo "✓ Configuration updated successfully"
