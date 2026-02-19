# SSH Config Support

## 🎯 Feature Overview

The Stateful SSH plugin now **parses `~/.ssh/config`** just like a standard SSH client!

This means you can:

- ✅ Use **hostnames** instead of IPs (e.g., `moltbot-1` instead of `192.168.2.134`)
- ✅ Define **host-specific SSH keys** (e.g., `id_ed25519_moltbot-1`, `id_ed25519_other-server`)
- ✅ Use **wildcard patterns** (e.g., `Host *.local`)
- ✅ Configure everything **once** in `~/.ssh/config`

**This is the standard way SSH clients work!**

---

## 📝 SSH Config Format

Create or edit `~/.ssh/config`:

```ssh-config
# Define host aliases with their connection details
Host moltbot-1
    HostName 192.168.2.134
    User pi
    IdentityFile ~/.ssh/bot_key

Host raspberry-pi-2
    HostName 192.168.2.135
    User admin
    IdentityFile ~/.ssh/id_ed25519_rpi2

# Wildcard patterns work too
Host *.local
    IdentityFile ~/.ssh/id_ed25519_local

# Use specific keys for specific servers
Host production-server
    HostName 10.0.1.50
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519_production
```

---

## 🧪 Usage Examples

### Example 1: Connect by Hostname

**SSH Config:**

```
Host moltbot-1
    HostName 192.168.2.134
    User pi
    IdentityFile ~/.ssh/bot_key
```

**Bot Command:**

```
Connect to moltbot-1 and run 'hostname'
```

**What happens:**

1. Plugin reads `~/.ssh/config`
2. Finds `Host moltbot-1`
3. Resolves `HostName` to `192.168.2.134`
4. Uses `IdentityFile ~/.ssh/bot_key`
5. Connects automatically!

**Log output:**

```
[SSH] No authentication provided, searching for SSH key for host: moltbot-1
[SSH] Found SSH key from config: /home/node/.ssh/bot_key
[SSH] Using automatically detected SSH key
```

---

### Example 2: Host-Specific Keys

**SSH Config:**

```
Host server-a
    HostName 192.168.1.10
    IdentityFile ~/.ssh/id_ed25519_server_a

Host server-b
    HostName 192.168.1.11
    IdentityFile ~/.ssh/id_ed25519_server_b
```

**Bot Commands:**

```
Connect to server-a and run 'pwd'
```

→ Uses `id_ed25519_server_a`

```
Connect to server-b and run 'pwd'
```

→ Uses `id_ed25519_server_b`

**Different keys for different servers!**

---

### Example 3: Wildcard Patterns

**SSH Config:**

```
Host *.production
    IdentityFile ~/.ssh/id_ed25519_production
    User deploy

Host *.development
    IdentityFile ~/.ssh/id_ed25519_dev
    User developer
```

**Bot Command:**

```
Connect to web1.production and run 'uptime'
```

→ Matches `*.production` pattern, uses production key

---

## 🔍 How It Works

### Search Order

When you connect **without** providing a password or key:

1. **Check SSH Config** (`~/.ssh/config`)
   - Look for matching `Host` entry
   - Extract `IdentityFile` path
   - Read and use that key

2. **Fall Back to Default Keys** (if no config match)
   - Try `~/.ssh/bot_key`
   - Try `~/.ssh/id_ed25519`
   - Try `~/.ssh/id_ecdsa`
   - Try `~/.ssh/id_rsa`
   - Try `~/.ssh/id_dsa`

3. **Fail with Error** (if nothing found)

---

## 📋 Supported SSH Config Directives

### Currently Supported

- ✅ `Host` - Define host alias/pattern
- ✅ `HostName` - Real hostname or IP
- ✅ `IdentityFile` - Path to private key
- ✅ Wildcard patterns (e.g., `Host *.local`)
- ✅ Path expansion (`~`, `$HOME`, `${HOME}`)

### Not Yet Supported (Future)

- ⏳ `Port` - Custom SSH port
- ⏳ `User` - Default username
- ⏳ `ProxyJump` - SSH bastion/jump hosts
- ⏳ `Include` - Include other config files

**Note:** Port and User can be specified in the bot command for now.

---

## 🛠️ Setup Instructions

### On the Host (Raspberry Pi)

1. **Create SSH config** (if not exists):

   ```bash
   mkdir -p ~/.ssh
   touch ~/.ssh/config
   chmod 600 ~/.ssh/config
   ```

2. **Edit config**:

   ```bash
   nano ~/.ssh/config
   ```

3. **Add your hosts**:

   ```
   Host moltbot-1
       HostName 192.168.2.134
       User pi
       IdentityFile ~/.ssh/bot_key
   ```

4. **Copy to container**:
   ```bash
   docker cp ~/.ssh/config moltbot-openclaw-gateway-1:/home/node/.ssh/config
   docker exec moltbot-openclaw-gateway-1 chmod 644 /home/node/.ssh/config
   docker exec moltbot-openclaw-gateway-1 chown node:node /home/node/.ssh/config
   ```

### In the Container

The config is already set up at `/home/node/.ssh/config`!

**Verify:**

```bash
docker exec moltbot-openclaw-gateway-1 cat /home/node/.ssh/config
```

---

## 🧪 Testing

### Test 1: Connect by Hostname

**Telegram/WhatsApp:**

```
Hey, connect to moltbot-1 and run 'hostname'
```

**Expected:**

- ✅ Resolves to 192.168.2.134
- ✅ Uses `/home/node/.ssh/bot_key`
- ✅ Connects successfully

### Test 2: Connect by IP (Still Works)

```
Hey, connect to 192.168.2.134 as user 'pi' and run 'hostname'
```

**Expected:**

- ✅ No match in config
- ✅ Falls back to default keys
- ✅ Finds `/home/node/.ssh/bot_key`
- ✅ Connects successfully

### Test 3: Non-Existent Host

```
Hey, connect to non-existent-host
```

**Expected:**

- ❌ No match in config
- ❌ No default keys work
- ❌ Error: "No authentication method provided..."

---

## 📊 Comparison

### Before SSH Config Support

```
Connect to 192.168.2.134 as user 'pi' using this private key:
-----BEGIN OPENSSH PRIVATE KEY-----
[long key content]
-----END OPENSSH PRIVATE KEY-----
```

### After SSH Config Support

```
Connect to moltbot-1
```

**Much cleaner!** ✨

---

## 🔐 Security Best Practices

### 1. Use Host-Specific Keys

**Bad:**

```
Host *
    IdentityFile ~/.ssh/id_rsa
```

→ Uses same key everywhere

**Good:**

```
Host production-*
    IdentityFile ~/.ssh/id_ed25519_production

Host development-*
    IdentityFile ~/.ssh/id_ed25519_dev
```

→ Different keys for different environments

### 2. Restrict Permissions

```bash
chmod 600 ~/.ssh/config      # Config file
chmod 600 ~/.ssh/*_key       # Private keys
chmod 644 ~/.ssh/*.pub       # Public keys (if any)
```

### 3. Use Ed25519 Keys

```bash
ssh-keygen -t ed25519 -C "bot@project-name" -f ~/.ssh/id_ed25519_project
```

Smaller, faster, more secure than RSA!

---

## 🚀 Advanced Examples

### Example 1: Multi-Environment Setup

```
# Development
Host dev-*
    HostName 192.168.1.%h
    User developer
    IdentityFile ~/.ssh/id_ed25519_dev

# Staging
Host staging-*
    HostName 10.0.1.%h
    User deploy
    IdentityFile ~/.ssh/id_ed25519_staging

# Production (extra careful!)
Host prod-web1
    HostName 10.0.2.10
    User deploy
    IdentityFile ~/.ssh/id_ed25519_production
```

**Bot can now connect to:**

- `dev-web1` → auto-resolves and uses dev key
- `staging-api` → auto-resolves and uses staging key
- `prod-web1` → uses production key

### Example 2: Local Network Shorthand

```
Host *.local
    IdentityFile ~/.ssh/id_ed25519_local
    User pi

Host rpi1.local
    HostName 192.168.2.134

Host rpi2.local
    HostName 192.168.2.135
```

**Usage:**

```
Connect to rpi1.local
Connect to rpi2.local
```

---

## 🐛 Troubleshooting

### SSH Config Not Found

**Error:**

```
[SSH] Could not read /home/node/.ssh/config: ENOENT
```

**Solution:**

```bash
# Create config in container
docker exec moltbot-openclaw-gateway-1 sh -c 'cat > /home/node/.ssh/config << EOF
Host moltbot-1
    HostName 192.168.2.134
    IdentityFile ~/.ssh/bot_key
EOF'
```

### Key File Not Found

**Error:**

```
[SSH] Could not read key file /home/node/.ssh/id_ed25519_server: ENOENT
```

**Solution:**

1. Check key exists in container:

   ```bash
   docker exec moltbot-openclaw-gateway-1 ls -la /home/node/.ssh/
   ```

2. Copy key if missing:
   ```bash
   docker cp ~/.ssh/id_ed25519_server moltbot-openclaw-gateway-1:/home/node/.ssh/
   ```

### Host Not Matching

**Issue:** Bot doesn't find config entry

**Debug:**

```bash
# View config
docker exec moltbot-openclaw-gateway-1 cat /home/node/.ssh/config

# Check logs
docker logs --tail 50 moltbot-openclaw-gateway-1 | grep SSH
```

**Common issues:**

- Typo in hostname
- Wrong indentation (use spaces, not tabs)
- Missing `IdentityFile` directive

---

## 📚 Further Reading

- [SSH Config Man Page](https://man.openbsd.org/ssh_config)
- [SSH Config Best Practices](https://www.ssh.com/academy/ssh/config)
- [Ed25519 vs RSA Keys](https://security.stackexchange.com/questions/90077/ssh-key-ed25519-vs-rsa)

---

## 🎓 Technical Details

### Implementation

**Location:** `extensions/stateful-ssh/src/session-manager.ts`

**Key Functions:**

- `findKeyFromSSHConfig(host)` - Parse config, find matching host
- `matchesHost(target, pattern, hostname)` - Match host patterns
- `expandAndReadKey(keyPath)` - Expand paths and read keys

**Config Parsing:**

1. Read `~/.ssh/config` line by line
2. Track current `Host` block
3. Extract `HostName` and `IdentityFile` directives
4. Match target host against patterns
5. Return key content if match found

**Path Expansion:**

- `~` → `/home/node`
- `$HOME` → `/home/node`
- `${HOME}` → `/home/node`

---

**Feature Added:** 2026-02-11
**Status:** ✅ Active
**Version:** 2026.2.9+
