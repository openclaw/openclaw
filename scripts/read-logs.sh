#!/bin/bash
set -e

DEFAULT_LOGS_DIR="${OPENCLAW_LOGS_DIR:-./logs}"
echo "Reading recent logs from $DEFAULT_LOGS_DIR"

if [ -z "$(ls -A "$DEFAULT_LOGS_DIR" 2>/dev/null)" ]; then
    echo "No logs found in $DEFAULT_LOGS_DIR."
else
    tail -n 50 "$DEFAULT_LOGS_DIR"/*.log 2>/dev/null || echo "No .log files found."
fi
