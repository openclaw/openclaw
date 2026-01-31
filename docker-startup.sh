#!/bin/bash
# Docker startup script - installs additional packages and runs the main command

# Install npm packages if OPENCLAW_NPM_PACKAGES is set
if [ -n "$OPENCLAW_NPM_PACKAGES" ]; then
  echo "Installing npm packages: $OPENCLAW_NPM_PACKAGES"
  npm install -g $OPENCLAW_NPM_PACKAGES 2>/dev/null || true
fi

# Execute the main command
exec "$@"
