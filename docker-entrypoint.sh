#!/bin/bash
set -e

# Create config directory
mkdir -p ~/.openclaw

# Create config file with trustedProxies for Docker/Coolify environment
cat > ~/.openclaw/openclaw.json << 'EOF'
{
  "gateway": {
    "trustedProxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"]
  }
}
EOF

# Execute the main command
exec "$@"
