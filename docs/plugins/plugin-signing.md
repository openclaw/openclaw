# Plugin Signing and Verification

OpenClaw supports cryptographic signing and verification of plugins to ensure they come from trusted sources and haven't been tampered with.

## Overview

The plugin signing system uses RSA-SHA256 cryptographic signatures to verify plugin authenticity and integrity. This prevents:

- **Malicious code injection**: Ensures plugins haven't been modified after signing
- **Untrusted sources**: Only loads plugins signed by trusted developers
- **Supply chain attacks**: Verifies the entire plugin package matches the developer's signed version

## For Plugin Developers

### 1. Generate Signing Keys

First, generate a key pair for signing your plugins:

```bash
bash scripts/generate-signing-keys.sh
```

This creates:

- `keys/plugin-signing-key.pem` - Private key (KEEP SECRET!)
- `keys/plugin-signing-key.pub` - Public key (share with users)

**Important**: Add `keys/` to your `.gitignore` to prevent accidentally committing your private key.

### 2. Sign Your Plugin

Sign a plugin file before distribution:

```bash
pnpm tsx scripts/sign-plugin.ts ./plugins/my-plugin/index.ts 1.0.0
```

This creates `plugin.signature.json` in the same directory as your plugin:

```json
{
  "algorithm": "RSA-SHA256",
  "signature": "base64-encoded-signature",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "timestamp": 1708095234567,
  "version": "1.0.0"
}
```

### 3. Distribute Plugin with Signature

When distributing your plugin, include:

- The plugin code (e.g., `index.ts`)
- The signature file (`plugin.signature.json`)
- Your public key (so users can verify)

### 4. CI/CD Integration

For automated signing in CI/CD pipelines:

#### GitHub Actions

1. Add your private key as a repository secret:
   - Go to Settings > Secrets and variables > Actions
   - Create a new secret named `PLUGIN_SIGNING_KEY`
   - Paste the contents of `keys/plugin-signing-key.pem` (base64 encoded):
     ```bash
     cat keys/plugin-signing-key.pem | base64 | pbcopy
     ```

2. Tag your release:

   ```bash
   git tag plugin-my-plugin-v1.0.0
   git push --tags
   ```

3. The workflow will automatically:
   - Sign the plugin
   - Create a GitHub release
   - Attach the signed plugin package

The workflow supports tags in the format: `plugin-<name>-v<version>`

Example: `plugin-memory-sqlite-v1.0.0`

#### Manual Workflow Dispatch

You can also trigger signing manually:

1. Go to Actions > Sign and Publish Plugin
2. Click "Run workflow"
3. Enter the plugin path and version
4. The signed plugin will be available as a downloadable artifact

## For Plugin Users

### 1. Obtain Public Keys

Get the public key from your plugin developer. They should publish it in their documentation or repository.

Save trusted public keys to files, for example:

```bash
mkdir -p ~/.openclaw/trusted-keys
curl -o ~/.openclaw/trusted-keys/developer1.pub https://example.com/keys/public.pem
```

### 2. Configure Trusted Keys

Add trusted public keys to your OpenClaw configuration:

```yaml
# ~/.openclaw/config.yaml
plugins:
  requireSignature: true # Enforce signature verification
  trustedPublicKeys:
    - |
      -----BEGIN PUBLIC KEY-----
      MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
      -----END PUBLIC KEY-----
    - |
      -----BEGIN PUBLIC KEY-----
      MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
      -----END PUBLIC KEY-----
```

Alternatively, load from files:

```typescript
import fs from "fs";

const config = {
  plugins: {
    requireSignature: true,
    trustedPublicKeys: [
      fs.readFileSync("~/.openclaw/trusted-keys/developer1.pub", "utf8"),
      fs.readFileSync("~/.openclaw/trusted-keys/developer2.pub", "utf8"),
    ],
  },
};
```

### 3. Install Signed Plugins

When you install a plugin with a valid signature, it will load normally:

```bash
openclaw plugin install ./my-plugin
```

If signature verification fails, you'll see an error:

```
❌ Plugin signature verification failed: Invalid signature
```

## Security Features

### Production Mode

In production mode (`NODE_ENV=production`), signature verification is automatically enforced for all non-bundled plugins.

### Bundled Plugins

Plugins that ship with OpenClaw (bundled plugins) are always trusted and skip signature verification.

### Signature Verification Process

1. **Existence Check**: Verifies `plugin.signature.json` exists
2. **Trust Check**: Ensures the signature's public key is in the trusted list
3. **Integrity Check**: Verifies the plugin code matches the signature
4. **Tampering Detection**: Detects any modifications to the plugin after signing

### What Gets Signed

The signature covers:

- Complete plugin code
- Plugin version
- Signature timestamp

This means any modification to the plugin code will invalidate the signature.

## Best Practices

### For Developers

1. **Protect Your Private Key**
   - Never commit it to version control
   - Store it in a secure location (password manager, vault)
   - Use CI/CD secrets for automated signing

2. **Version Your Signatures**
   - Sign each version separately
   - Include the version in the signature

3. **Publish Your Public Key**
   - Make it easily accessible to users
   - Include it in your README
   - Host it on your website

4. **Sign Before Distribution**
   - Always sign plugins before publishing
   - Verify the signature works before distribution

### For Users

1. **Verify Public Keys**
   - Get public keys from official sources only
   - Verify the key fingerprint if possible

2. **Enable Signature Verification**
   - Set `requireSignature: true` in production
   - Keep your trusted keys list updated

3. **Review Plugins**
   - Even signed plugins should be reviewed
   - Signatures verify authenticity, not safety

4. **Use Multiple Trust Anchors**
   - Add multiple trusted developers
   - Diversify your plugin sources

## Troubleshooting

### "No signature found"

The plugin doesn't have a `plugin.signature.json` file. Either:

- The plugin is unsigned (ask the developer to sign it)
- The signature file is missing (re-download the plugin)

### "Untrusted public key"

The plugin is signed, but not by a trusted developer. Either:

- Add the developer's public key to `trustedPublicKeys`
- Verify the developer's identity before trusting

### "Invalid signature"

The plugin has been modified after signing. This could indicate:

- Tampering or corruption
- Accidental modification
- Re-download from the official source

### "Signature verification failed"

General verification error. Check:

- The signature file is valid JSON
- The public key format is correct (PEM)
- The plugin file exists and is readable

## Technical Details

### Algorithm

- **Signature Algorithm**: RSA-SHA256
- **Key Size**: 4096 bits (recommended), minimum 2048 bits
- **Encoding**: PEM format for keys, Base64 for signatures

### Signature Format

```typescript
interface PluginSignature {
  algorithm: "RSA-SHA256" | "Ed25519";
  signature: string; // Base64-encoded signature
  publicKey: string; // PEM-formatted public key
  timestamp: number; // Unix timestamp (ms)
  version: string; // Plugin version
}
```

### File Locations

- Signature file: `plugin.signature.json` (same directory as plugin)
- Private key: Configurable via `PLUGIN_SIGNING_KEY` env var
- Public keys: Stored in OpenClaw config

## API Reference

### PluginSigner Class

#### `signPlugin(pluginPath, privateKey, version)`

Signs a plugin file.

**Parameters:**

- `pluginPath` (string): Path to plugin file
- `privateKey` (string): PEM-formatted private key
- `version` (string): Plugin version

**Returns:** `PluginSignature`

#### `verifySignature(pluginPath, signature, trustedPublicKeys)`

Verifies a plugin signature.

**Parameters:**

- `pluginPath` (string): Path to plugin file
- `signature` (PluginSignature): Signature object
- `trustedPublicKeys` (string[]): Array of trusted public keys

**Returns:** `boolean` (true if valid)

**Throws:** Error if verification fails

#### `verifyPluginDirectory(pluginDir, pluginFile, trustedPublicKeys)`

Verifies plugin and loads signature from directory.

**Parameters:**

- `pluginDir` (string): Plugin directory
- `pluginFile` (string): Plugin filename
- `trustedPublicKeys` (string[]): Array of trusted public keys

**Returns:** `SignatureVerificationResult`

#### `checkIntegrity(pluginPath, signaturePath)`

Checks if plugin matches its signature.

**Parameters:**

- `pluginPath` (string): Path to plugin file
- `signaturePath` (string): Path to signature file

**Returns:** `boolean` (true if integrity check passes)

## Examples

### Example: Sign Multiple Plugins

```bash
#!/bin/bash
for plugin in plugins/*/index.ts; do
  VERSION=$(jq -r '.version' "$(dirname "$plugin")/package.json")
  pnpm tsx scripts/sign-plugin.ts "$plugin" "$VERSION"
done
```

### Example: Verify Signature Programmatically

```typescript
import { PluginSigner } from "./src/plugins/plugin-signing";
import fs from "fs";

const publicKey = fs.readFileSync("./keys/developer.pub", "utf8");
const result = PluginSigner.verifyPluginDirectory("./plugins/my-plugin", "index.ts", [publicKey]);

if (result.valid) {
  console.log("✅ Signature valid!");
  console.log(`Version: ${result.signature?.version}`);
} else {
  console.error("❌ Verification failed:", result.error);
}
```

### Example: Load Plugin with Verification

```typescript
import { loadOpenClawPlugins } from "./src/plugins/loader";

const registry = loadOpenClawPlugins({
  config: {
    plugins: {
      requireSignature: true,
      trustedPublicKeys: [fs.readFileSync("./keys/trusted-dev.pub", "utf8")],
    },
  },
});

// Only signed plugins will be loaded
```

## FAQ

**Q: Do I need to sign bundled plugins?**
A: No, bundled plugins (shipped with OpenClaw) are always trusted.

**Q: Can I use multiple signing keys?**
A: Yes, users can trust multiple public keys from different developers.

**Q: What happens if I lose my private key?**
A: You'll need to generate a new key pair. Users will need to trust your new public key.

**Q: How do I rotate signing keys?**
A: Generate a new key pair, sign new releases with it, and publish the new public key. Users should add both old and new keys during the transition period.

**Q: Is signature verification required?**
A: It's optional in development, but strongly recommended for production. You can enable it with `requireSignature: true`.

**Q: Can signatures be forged?**
A: No, without access to the private key, signatures cannot be forged. Keep your private key secure!

## See Also

- [Plugin Development Guide](./development.md)
- [Plugin Distribution](./distribution.md)
- [Security Best Practices](../security/best-practices.md)
