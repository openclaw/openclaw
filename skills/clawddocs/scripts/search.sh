#!/bin/bash
# Search docs by keyword
if [ -z "$1" ]; then
  echo "Usage: search.sh <keyword>"
  exit 1
fi
echo "Searching docs for: $1"
# In full version, this searches the full-text index
