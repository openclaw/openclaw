# Automatic SSH Key Detection

## 🎯 Feature Overview

The Stateful SSH plugin now **automatically detects and uses SSH keys** from `~/.ssh/`, just like a standard SSH client!

**You no longer need to provide a password or private key** - the plugin will search for default SSH keys automatically.

---

## ✨ How It Works

When you open an SSH session **without** providing a `password` or `privateKey` parameter, the plugin automatically:

1. **Checks SSH Config** (`~/.ssh/config`)
   - Looks for matching `Host` entry
   - Extracts host-specific `IdentityFile`
   - ⭐ **NEW**: Supports hostnames, host-specific keys, wildcards!

2. **Falls back to standard keys** (if no config match)
   - Searches `~/.ssh/` for private keys
   - Tries keys in this order:
     - `bot_key` (our custom bot key)
     - `id_ed25519` (modern, recommended)
     - `id_ecdsa` (ECDSA)
     - `id_rsa` (classic RSA)
     - `id_dsa` (legacy, deprecated)

3. Uses the first readable key it finds
4. Connects to the server

**This mimics standard SSH client behavior exactly!**

💡 **See also:** [SSH-CONFIG-SUPPORT.md](./SSH-CONFIG-SUPPORT.md) for host-specific key configuration

---

## 🧪 Usage Examples

### Simple Connection (Recommended)

**Before** (explicit key):

```
Connect to 192.168.2.134 as user 'pi' using the SSH private key:
[long key content]
Then run 'hostname'
```

**Now** (auto-detection):

```
Connect to 192.168.2.134 as user 'pi'
Then run 'hostname'
```

That's it! No password, no key content needed.

---

### Bot Commands

#### Telegram/WhatsApp

**Minimal Command:**

```
Hey, connect to 192.168.2.134 as user 'pi', run 'pwd' and 'whoami', then close the session.
```

**Longer Command (same result):**

```
Please test SSH connection.
Connect to 192.168.2.134 as user 'pi' (use auto-detected SSH key).
Execute these commands:
- hostname
- pwd
- whoami
Close the session when done.
```

#### What Happens Behind the Scenes

```json
{
  "tool": "open_ssh_session",
  "parameters": {
    "host": "192.168.2.134",
    "username": "pi"
    // Note: No password, no privateKey!
  }
}
```

The plugin automatically:

1. Checks `/home/node/.ssh/bot_key` → ✅ Found!
2. Reads the key content
3. Uses it for authentication
4. Logs: `[SSH] Found default private key: /home/node/.ssh/bot_key`

---

## 🔍 Debugging

### Check Which Key Was Used

Look at the logs:

```bash
docker logs moltbot-openclaw-gateway-1 | grep -i "ssh"
```

You should see:

```
[SSH] No authentication provided, searching for default SSH key...
[SSH] Found default private key: /home/node/.ssh/bot_key
[SSH] Using automatically detected SSH key
```

### If Auto-Detection Fails

Error message:

```
No authentication method provided. Either provide a password, privateKey, or
ensure a default SSH key exists in ~/.ssh/
```

**Solutions:**

1. **Check if key exists in container:**

   ```bash
   docker exec moltbot-openclaw-gateway-1 ls -la /home/node/.ssh/
   ```

2. **Verify key is readable:**

   ```bash
   docker exec moltbot-openclaw-gateway-1 cat /home/node/.ssh/bot_key | head -1
   ```

   Should show: `-----BEGIN OPENSSH PRIVATE KEY-----`

3. **Re-copy key if needed:**
   ```bash
   docker cp ~/.ssh/openclaw_bot_key moltbot-openclaw-gateway-1:/home/node/.ssh/bot_key
   docker exec moltbot-openclaw-gateway-1 chmod 600 /home/node/.ssh/bot_key
   ```

---

## 📋 Fallback Options

### You Can Still Use Explicit Auth

The auto-detection is **optional**. You can still provide explicit authentication:

#### Option 1: Password (not recommended)

```
Connect to 192.168.2.134 as user 'pi' with password 'power123'
```

#### Option 2: Explicit Key Content

```
Connect to 192.168.2.134 as user 'pi' using this private key:
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
```

#### Option 3: Auto-Detection (recommended)

```
Connect to 192.168.2.134 as user 'pi'
```

All three work! Auto-detection is just the most convenient.

---

## 🔐 Security Considerations

### Key Search Order

The plugin checks keys in this specific order:

1. **bot_key** - Custom bot key (highest priority)
2. **id_ed25519** - Modern Ed25519 (recommended)
3. **id_ecdsa** - ECDSA
4. **id_rsa** - Classic RSA
5. **id_dsa** - Legacy DSA (lowest priority)

**Why this order?**

- `bot_key` first ensures the bot uses its dedicated key
- Ed25519 is more secure than RSA/ECDSA
- DSA is deprecated but checked for compatibility

### Key Permissions

Keys must be readable by the container user (`node:node`):

```bash
-rw------- 1 node node 411 bot_key
```

Permissions `600` (owner read/write only) are correct and secure.

### Multiple Keys

If you have multiple keys, the plugin uses the **first one it finds**. To control which key is used:

**Option 1:** Remove unused keys from `/home/node/.ssh/`

**Option 2:** Provide explicit key in the command

---

## 🚀 Benefits

### For Users

- ✅ **Simpler commands** - no need to paste long keys
- ✅ **Less clutter** - chat logs stay clean
- ✅ **Faster** - fewer tokens, quicker responses
- ✅ **Familiar** - works like normal SSH

### For Bot

- ✅ **No memory burden** - doesn't need to remember keys
- ✅ **Consistent auth** - same key every time
- ✅ **Automatic** - zero configuration needed per session

### For Security

- ✅ **Keys not in logs** - no sensitive data in chat history
- ✅ **Centralized management** - one place to update keys
- ✅ **Standard practice** - follows SSH conventions

---

## 📊 Comparison

| Method             | Command Length | Security  | Convenience |
| ------------------ | -------------- | --------- | ----------- |
| **Auto-detection** | Short          | ✅ High   | ✅ Best     |
| **Explicit key**   | Very long      | ⚠️ Medium | ❌ Tedious  |
| **Password**       | Short          | ❌ Low    | ⚠️ OK       |

**Recommendation:** Use auto-detection for all connections!

---

## 🛠️ Advanced: Custom Key Names

Want to use a key with a custom name?

### Method 1: Rename to Standard Name

```bash
cp ~/.ssh/my_custom_key /home/node/.ssh/bot_key
```

### Method 2: Add to Search List

Edit `session-manager.ts`:

```typescript
const keyFilenames = [
  "bot_key",
  "my_custom_key", // Add your key here
  "id_ed25519",
  "id_rsa",
];
```

Rebuild and restart.

---

## 🧩 Integration with Existing Workflows

### Before This Feature

```
SYSTEM: When connecting to SSH servers, remember to use the private key from /home/node/.ssh/bot_key. Read the file content first, then pass it to open_ssh_session.
```

Workflow:

1. Read key file
2. Pass content to tool
3. Connect

### After This Feature

```
SYSTEM: You can connect to SSH servers directly. No need to specify keys.
```

Workflow:

1. Connect (auto-detection handles the rest!)

**Much simpler!** ✨

---

## 📝 Key Lifecycle

### Setup (One-Time)

1. Generate key: `ssh-keygen -t ed25519 -f ~/.ssh/openclaw_bot_key`
2. Copy to servers: `ssh-copy-id -i ~/.ssh/openclaw_bot_key.pub user@server`
3. Mount in container: `docker cp ~/.ssh/openclaw_bot_key container:/home/node/.ssh/bot_key`

### Usage (Every Session)

1. Just connect! Auto-detection works automatically.

### Maintenance

- **Rotate keys**: Replace `/home/node/.ssh/bot_key`, restart container
- **Revoke access**: Remove public key from target server's `authorized_keys`
- **Update**: New keys automatically detected on next connection

---

## ✅ Testing Auto-Detection

### Quick Test

**Via Telegram/WhatsApp:**

```
Hey, test SSH auto-detection!
Connect to 192.168.2.134 as user 'pi' (don't provide any password or key).
Run 'hostname' and close the session.
```

**Expected Result:**

```
SSH session opened successfully.
Session ID: abc12345
Host: 192.168.2.134
Username: pi
[Authentication method: auto-detected SSH key]
```

### Verify in Logs

```bash
docker logs --tail 20 moltbot-openclaw-gateway-1 | grep SSH
```

Should show:

```
[SSH] No authentication provided, searching for default SSH key...
[SSH] Found default private key: /home/node/.ssh/bot_key
[SSH] Using automatically detected SSH key
```

---

## 🎓 Technical Details

### Implementation

Location: `extensions/stateful-ssh/src/session-manager.ts`

**Key Function:**

```typescript
private async findDefaultPrivateKey(): Promise<string | null> {
  const sshDir = `${homedir()}/.ssh`;
  const keyFilenames = ["bot_key", "id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

  for (const filename of keyFilenames) {
    const keyPath = `${sshDir}/${filename}`;
    try {
      await access(keyPath, constants.R_OK);
      const keyContent = await readFile(keyPath, "utf-8");
      console.log(`[SSH] Found default private key: ${keyPath}`);
      return keyContent;
    } catch {
      continue;
    }
  }

  return null;
}
```

**Integration Point:**

```typescript
async openSession(config: SSHSessionConfig): Promise<string> {
  // Auto-detect SSH key if no authentication method provided
  if (!config.password && !config.privateKey) {
    const defaultKey = await this.findDefaultPrivateKey();
    if (defaultKey) {
      config.privateKey = defaultKey;
    }
  }
  // ... rest of connection logic
}
```

### Dependencies

Uses Node.js built-ins:

- `fs/promises` - File system access
- `os` - Home directory detection
- `ssh2` - SSH client (unchanged)

No additional dependencies required!

---

**Feature Added**: 2026-02-11
**Status**: ✅ Active and Ready
**Compatibility**: OpenClaw v2026.2.9+
