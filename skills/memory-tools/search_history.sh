#!/bin/bash
set -euo pipefail
# Quick wrapper for semantic history search
# Usage: search_history.sh "your query here" [top_k]
# Copyright (c) 2026 Arthur Arsyonov — looi.ru
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$SCRIPT_DIR/search_history_fast.py" "$1" "${2:-7}"
