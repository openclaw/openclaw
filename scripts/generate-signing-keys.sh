#!/bin/bash
#
# Generate RSA key pair for plugin signing
#
# This script creates:
# - keys/plugin-signing-key.pem (private key) - KEEP THIS SECRET
# - keys/plugin-signing-key.pub (public key) - Share this with users
#

set -e

KEYS_DIR="./keys"
PRIVATE_KEY="$KEYS_DIR/plugin-signing-key.pem"
PUBLIC_KEY="$KEYS_DIR/plugin-signing-key.pub"

echo "🔑 Generating plugin signing keys..."
echo ""

# Create keys directory if it doesn't exist
if [ ! -d "$KEYS_DIR" ]; then
  mkdir -p "$KEYS_DIR"
  echo "Created keys directory: $KEYS_DIR"
fi

# Check if keys already exist
if [ -f "$PRIVATE_KEY" ]; then
  echo "⚠️  WARNING: Private key already exists at $PRIVATE_KEY"
  read -p "   Overwrite existing keys? (y/N): " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# Generate private key
echo "Generating 4096-bit RSA private key..."
openssl genrsa -out "$PRIVATE_KEY" 4096 2>/dev/null

# Extract public key
echo "Extracting public key..."
openssl rsa -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" 2>/dev/null

# Set proper permissions
chmod 600 "$PRIVATE_KEY"
chmod 644 "$PUBLIC_KEY"

echo ""
echo "✅ Signing keys generated successfully!"
echo ""
echo "Files created:"
echo "  🔒 Private key: $PRIVATE_KEY"
echo "  🔓 Public key:  $PUBLIC_KEY"
echo ""
echo "⚠️  IMPORTANT SECURITY NOTES:"
echo ""
echo "  1. KEEP THE PRIVATE KEY SECRET!"
echo "     - Never commit $PRIVATE_KEY to version control"
echo "     - Store it securely (password manager, secrets vault)"
echo "     - Add 'keys/' to .gitignore if not already there"
echo ""
echo "  2. DISTRIBUTE THE PUBLIC KEY"
echo "     - Share $PUBLIC_KEY with plugin users"
echo "     - Add it to your OpenClaw config for verification"
echo "     - Can be safely committed to version control"
echo ""
echo "  3. USE IN CI/CD"
echo "     - Store private key as a secret (GitHub Actions secret, etc.)"
echo "     - Export as PLUGIN_SIGNING_KEY environment variable"
echo ""
echo "Next steps:"
echo "  1. Sign a plugin:"
echo "     pnpm tsx scripts/sign-plugin.ts ./plugins/my-plugin/index.ts 1.0.0"
echo ""
echo "  2. Add public key to OpenClaw config:"
echo "     cat $PUBLIC_KEY"
echo ""
