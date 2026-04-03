#!/bin/bash

# Validate plugin structure and metadata

if [ -z "$1" ]; then
  echo "Usage: $0 <plugin-directory>"
  exit 1
fi

PLUGIN_DIR=$1

if [ ! -d "$PLUGIN_DIR" ]; then
  echo "Error: Directory $PLUGIN_DIR does not exist."
  exit 1
fi

# Check for manifest.json
if [ ! -f "$PLUGIN_DIR/manifest.json" ]; then
  echo "Error: manifest.json not found in $PLUGIN_DIR."
  exit 1
fi

# Check for main file
MAIN_FILE=$(jq -r '.main' "$PLUGIN_DIR/manifest.json")
if [ ! -f "$PLUGIN_DIR/$MAIN_FILE" ]; then
  echo "Error: Main file $MAIN_FILE not found in $PLUGIN_DIR."
  exit 1
fi

# Validate manifest.json
jq empty "$PLUGIN_DIR/manifest.json" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "Error: manifest.json is not valid JSON."
  exit 1
fi

echo "Plugin validation successful!"