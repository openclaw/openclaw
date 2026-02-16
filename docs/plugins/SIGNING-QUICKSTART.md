# Plugin Signing Quick Start

This guide will get you started with plugin signing in 5 minutes.

## For Plugin Developers

### 1. Generate Keys (One Time Setup)

```bash
pnpm plugin:keygen
```

This creates:

- `keys/plugin-signing-key.pem` (private - KEEP SECRET!)
- `keys/plugin-signing-key.pub` (public - share with users)

### 2. Sign Your Plugin

```bash
pnpm plugin:sign ./plugins/my-plugin/index.ts 1.0.0
```

### 3. Distribute

When sharing your plugin, include:

- Your plugin files
- `plugin.signature.json` (created in step 2)
- Your public key (`keys/plugin-signing-key.pub`)

### 4. Publish Your Public Key

Add your public key to your README:

````markdown
## Installation

1. Install the plugin:

   ```bash
   openclaw plugin install my-plugin
   ```

2. Add my public key to your OpenClaw config:
   ```yaml
   plugins:
     trustedPublicKeys:
       - |
         -----BEGIN PUBLIC KEY-----
         [paste contents of keys/plugin-signing-key.pub]
         -----END PUBLIC KEY-----
   ```
````

## For Plugin Users

### 1. Get the Public Key

Get the plugin developer's public key (from their README or website).

### 2. Add to Config

Edit `~/.openclaw/config.yaml`:

```yaml
plugins:
  requireSignature: true # Enforce verification
  trustedPublicKeys:
    - |
      -----BEGIN PUBLIC KEY-----
      [paste developer's public key here]
      -----END PUBLIC KEY-----
```

### 3. Install Plugin

```bash
openclaw plugin install ./my-plugin
```

If the signature is valid, the plugin loads normally. If not, you'll see an error.

## CI/CD (GitHub Actions)

### 1. Store Private Key as Secret

In your GitHub repository:

1. Go to Settings > Secrets > Actions
2. Add secret: `PLUGIN_SIGNING_KEY`
3. Value: Base64-encoded private key
   ```bash
   cat keys/plugin-signing-key.pem | base64
   ```

### 2. Tag and Push

```bash
git tag plugin-my-plugin-v1.0.0
git push --tags
```

The GitHub Action will automatically sign and publish your plugin!

## Troubleshooting

**"No signature found"**
→ Run `pnpm plugin:sign` to sign your plugin

**"Untrusted public key"**
→ Add the developer's public key to your `trustedPublicKeys` config

**"Invalid signature"**
→ Plugin was modified after signing. Re-download from official source.

## Next Steps

- Read the [full documentation](./plugin-signing.md)
- Learn about [plugin development](./development.md)
- See [security best practices](../security/best-practices.md)
