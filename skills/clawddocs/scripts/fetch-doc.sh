#!/bin/bash
# Fetch a specific doc
if [ -z "$1" ]; then
  echo "Usage: fetch-doc.sh <path>"
  exit 1
fi
echo "Fetching: https://docs.clawd.bot/$1"
