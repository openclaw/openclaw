#!/bin/bash
# Chromium Shim for OpenClaw (WSL2 + WSLg Support)
# Logs args and strips --headless to force UI visibility

LOGfile="/tmp/chromium-shim.log"
echo "[$(date)] RAW ARGS: $@" >> "$LOGfile"

# Filter out headless arguments to force UI
NEW_ARGS=()
for arg in "$@"; do
    if [[ "$arg" == "--headless"* ]]; then
        echo "  -> Stripping $arg" >> "$LOGfile"
        continue
    fi
    NEW_ARGS+=("$arg")
done

echo "  -> CLEAN ARGS: ${NEW_ARGS[@]}" >> "$LOGfile"

# Force Display
export DISPLAY=:0

# Execute Chromium with filtered args + standard flags
exec /usr/bin/chromium-browser \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    "${NEW_ARGS[@]}"
