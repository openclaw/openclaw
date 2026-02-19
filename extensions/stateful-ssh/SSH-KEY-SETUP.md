# SSH Key Authentication Setup

## Why Use SSH Keys?

✅ **More secure** than passwords
✅ **No password in chat/logs**
✅ **Can be revoked** without changing passwords
✅ **Standard practice** for automation

## Setup Options

### Option A: Key in Docker Volume (Recommended for Production)

#### 1. Generate SSH Key on the Server

```bash
# On the Raspberry Pi
ssh pi@192.168.2.134
cd ~
ssh-keygen -t ed25519 -C "openclaw-bot@moltbot" -f ~/.ssh/openclaw_bot_key -N ""
```

This creates:

- `~/.ssh/openclaw_bot_key` (private key)
- `~/.ssh/openclaw_bot_key.pub` (public key)

#### 2. Copy Public Key to Target Servers

```bash
# Copy to local pi user (for testing)
cat ~/.ssh/openclaw_bot_key.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Copy to other servers
ssh-copy-id -i ~/.ssh/openclaw_bot_key.pub user@other-server
```

#### 3. Mount Key into Docker Container

Edit `~/moltbot/docker-compose.yml`:

```yaml
services:
  openclaw-gateway:
    # ... existing config ...
    volumes:
      - ./extensions:/app/extensions # existing
      - /home/pi/.ssh/openclaw_bot_key:/app/secrets/ssh_key:ro # NEW
```

Restart container:

```bash
docker compose -f ~/moltbot/docker-compose.yml restart openclaw-gateway
```

#### 4. Use in Bot Commands

The bot can now read the key from `/app/secrets/ssh_key`:

```
Hey, connect to 192.168.2.134 as user 'pi' using the SSH key from /app/secrets/ssh_key
Then run 'hostname' and close the session.
```

**Note**: The bot would need to read the file first. For now, you can provide the key content directly.

---

### Option B: Key as Environment Variable (Good for CI/CD)

#### 1. Generate key (same as above)

```bash
ssh-keygen -t ed25519 -C "openclaw-bot@moltbot" -f ~/.ssh/openclaw_bot_key -N ""
```

#### 2. Add to docker-compose.yml

```yaml
services:
  openclaw-gateway:
    environment:
      - OPENCLAW_SSH_KEY=${OPENCLAW_SSH_KEY}
```

#### 3. Add to ~/.bashrc or docker-compose.extra.yml

```bash
export OPENCLAW_SSH_KEY="$(cat ~/.ssh/openclaw_bot_key)"
```

---

### Option C: Direct Key Passing (Quick Test, Less Secure)

Read the private key and provide it directly in the chat:

```bash
# On your local machine
cat ~/.ssh/id_ed25519  # or id_rsa
```

Then tell the bot:

```
Connect to 192.168.2.134 as user 'pi' using this private key:
[paste key content here]
```

**⚠️ Warning**: This exposes the key in chat logs. Only use for testing or with dedicated bot keys.

---

## Current Implementation Status

✅ **Supported Parameters**:

- `privateKey`: Private key in PEM/OpenSSH format (string)
- `passphrase`: Optional passphrase if key is encrypted
- `password`: Alternative to privateKey

✅ **Key Formats**:

- RSA (PEM format)
- Ed25519 (OpenSSH format)
- ECDSA
- All formats supported by `ssh2` library

✅ **Encrypted Keys**:
Yes, just provide the `passphrase` parameter

---

## Best Practices

### 1. Use Dedicated Bot Keys

Don't reuse your personal SSH keys. Generate a dedicated key for the bot:

```bash
ssh-keygen -t ed25519 -C "bot@yourproject" -f ~/.ssh/bot_key
```

### 2. Restrict Key Permissions

```bash
chmod 600 ~/.ssh/bot_key
```

### 3. Use authorized_keys Restrictions

In `~/.ssh/authorized_keys` on the target server:

```
command="/usr/bin/safe-commands-only",no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAA... bot@yourproject
```

This limits what the bot can do even if the key is compromised.

### 4. Audit and Rotate Keys

- Log all SSH connections
- Rotate keys regularly (e.g., every 90 days)
- Remove old keys from `authorized_keys`

---

## Testing SSH Key Authentication

### Quick Test (Manual)

```bash
# Test the key works
ssh -i ~/.ssh/openclaw_bot_key pi@192.168.2.134 'hostname'
```

### Bot Test (via Telegram)

Once you have the key set up, test with:

```
Hey, I want to test SSH key authentication.

Please connect to 192.168.2.134 as user 'pi' using this private key:
[paste private key content]

Then execute these commands:
- whoami
- hostname
- pwd

Finally, close the session.
```

**Expected Output**:

1. Session opens successfully
2. Commands execute (proving authentication worked)
3. Session closes cleanly

---

## Troubleshooting

### "Permission denied (publickey)"

- Check `~/.ssh/authorized_keys` contains the public key
- Verify key permissions: `chmod 600 ~/.ssh/bot_key`
- Check SSH server config: `PubkeyAuthentication yes`

### "Invalid key format"

- Ensure key is in PEM/OpenSSH format
- Try converting: `ssh-keygen -p -f key -m pem`

### "Encrypted key without passphrase"

- Provide the `passphrase` parameter
- Or remove passphrase: `ssh-keygen -p -f key -N ""`

---

**Last Updated**: 2026-02-11
**Author**: Claude Sonnet 4.5
