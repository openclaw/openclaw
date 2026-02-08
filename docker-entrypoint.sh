#!/bin/bash
set -e

# Define config directory
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}"
# Check for either openclaw.json (new default) or config.json (legacy)
if [ -f "$CONFIG_DIR/openclaw.json" ]; then
    CONFIG_FILE="$CONFIG_DIR/openclaw.json"
else
    CONFIG_FILE="$CONFIG_DIR/config.json"
fi

# Check if config exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Configuration not found at $CONFIG_DIR/openclaw.json (or config.json). Starting auto-onboarding..."

    # Build arguments for onboard command
    ARGS="onboard --non-interactive --accept-risk"

    if [ -n "$OPENCLAW_GATEWAY_PORT" ]; then
        ARGS="$ARGS --gateway-port $OPENCLAW_GATEWAY_PORT"
    fi

    if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
        ARGS="$ARGS --gateway-token $OPENCLAW_GATEWAY_TOKEN"
    fi

    if [ -n "$OPENCLAW_GATEWAY_BIND" ]; then
        ARGS="$ARGS --gateway-bind $OPENCLAW_GATEWAY_BIND"
    fi
    
    # Default auth choice to skip if not provided to avoid hanging
    if [ -z "$OPENCLAW_AUTH_CHOICE" ]; then
        ARGS="$ARGS --auth-choice skip"
    else
        ARGS="$ARGS --auth-choice $OPENCLAW_AUTH_CHOICE"
    fi

    echo "Running: node dist/index.js $ARGS"
    # Run in background to capture pid? No, just run it.
    node dist/index.js $ARGS
    
    echo "Onboarding completed."
fi

# Execute the main command (usually gateway)
echo "Starting OpenClaw Gateway..."
exec "$@"
