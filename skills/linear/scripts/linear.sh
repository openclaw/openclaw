#!/bin/bash
# Linear CLI wrapper that auto-loads .env

# Load environment from .env if it exists
if [ -f ~/.openclaw/.env ]; then
    set -a
    source ~/.openclaw/.env
    set +a
fi

# Pass all arguments to linear.py
cd "$(dirname "$0")" && python3 linear.py "$@"
