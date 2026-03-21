#!/bin/bash
# rclone setup checker - verifies installation and configuration

set -e

echo "=== rclone Setup Check ==="
echo

# Check if rclone is installed
if command -v rclone >/dev/null 2>&1; then
    echo "✓ rclone installed"
    rclone version | head -1
    echo
else
    echo "✗ rclone NOT INSTALLED"
    echo
    echo "Install with:"
    echo "  macOS:  brew install rclone"
    echo "  Linux:  curl https://rclone.org/install.sh | sudo bash"
    echo "          or: sudo apt install rclone"
    exit 1
fi

# Check for configured remotes
REMOTES=$(rclone listremotes 2>/dev/null || true)

if [ -z "$REMOTES" ]; then
    echo "✗ No remotes configured"
    echo
    echo "Run 'rclone config' to set up a remote, or use:"
    echo
    echo "  # Cloudflare R2"
    echo "  rclone config create r2 s3 provider=Cloudflare \\"
    echo "    access_key_id=KEY secret_access_key=SECRET \\"
    echo "    endpoint=ACCOUNT_ID.r2.cloudflarestorage.com"
    echo
    echo "  # AWS S3"
    echo "  rclone config create aws s3 provider=AWS \\"
    echo "    access_key_id=KEY secret_access_key=SECRET region=us-east-1"
    echo
    exit 1
else
    echo "✓ Configured remotes:"
    echo "$REMOTES" | sed 's/^/  /'
    echo
fi

# Test connectivity for each remote
echo "Testing remote connectivity..."
for remote in $REMOTES; do
    remote_name="${remote%:}"
    if rclone lsd "$remote" >/dev/null 2>&1; then
        echo "  ✓ $remote_name - connected"
    else
        echo "  ✗ $remote_name - connection failed (check credentials)"
    fi
done

echo
echo "=== Setup Complete ==="
