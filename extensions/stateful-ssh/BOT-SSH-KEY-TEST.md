# Bot SSH Key Authentication - Test Guide

## ✅ Setup Complete

SSH key authentication is now configured for the OpenClaw bot!

### What was done:

1. ✅ Generated dedicated Ed25519 SSH key: `~/.ssh/openclaw_bot_key`
2. ✅ Added public key to `~/.ssh/authorized_keys` on server
3. ✅ Tested key authentication (works!)
4. ✅ Copied private key into Docker container: `/home/node/.ssh/bot_key`
5. ✅ Set correct permissions (600, owned by node:node)

---

## 🧪 Testing Options

### Option 1: Using Key File Path (Recommended)

The bot can now read the key from its container filesystem:

**Telegram/WhatsApp Command:**

```
Hey, please test SSH key authentication!

Connect to 192.168.2.134 as user 'pi' using the SSH private key from file /home/node/.ssh/bot_key

Then execute:
- hostname
- whoami
- pwd

Finally, close the session.
```

**How it works:**

- Bot reads the file `/home/node/.ssh/bot_key` in the container
- Uses that key for authentication
- No password needed!

---

### Option 2: Direct Key Content (For Testing)

You can also provide the key content directly:

**Telegram/WhatsApp Command:**

```
Hey, please test SSH key authentication!

Connect to 192.168.2.134 as user 'pi' using this SSH private key:

-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBwgXR5XZYKaS+tsLZffy9ZejBnobw20GpUiFPWXWYJcAAAAJiECtuxhArb
sQAAAAtzc2gtZWQyNTUxOQAAACBwgXR5XZYKaS+tsLZffy9ZejBnobw20GpUiFPWXWYJcA
AAAEAdRiJtvIYuzefT0a7wWd/M/VDjztHIWGZ/hC9Tv3Dmj3CBdHldlgppL62wtl9/L1l6
MGehvDbQalSIU9ZdZglwAAAAFG9wZW5jbGF3LWJvdEBtb2x0Ym90AQ==
-----END OPENSSH PRIVATE KEY-----

Then execute:
- hostname
- whoami
- pwd

Finally, close the session.
```

---

## 🔒 Security Notes

### This Key is Bot-Only

- Key comment: `openclaw-bot@moltbot`
- Purpose: Dedicated for bot automation
- Not for manual use

### Key Properties

- Type: Ed25519 (modern, secure)
- Encryption: None (unencrypted for bot automation)
- Location (Host): `/home/pi/.ssh/openclaw_bot_key`
- Location (Container): `/home/node/.ssh/bot_key`

### Access Control

The key allows SSH access to:

- ✅ `pi@192.168.2.134` (Raspberry Pi moltbot-1)
- ✅ Any other server where you add the public key

---

## 🛠️ Maintenance

### After Container Restart

**Important:** The key is currently copied directly into the container. After a container restart, you need to copy it again:

```bash
ssh pi@192.168.2.134
docker cp ~/.ssh/openclaw_bot_key moltbot-openclaw-gateway-1:/home/node/.ssh/bot_key
docker exec moltbot-openclaw-gateway-1 chmod 600 /home/node/.ssh/bot_key
docker exec moltbot-openclaw-gateway-1 chown node:node /home/node/.ssh/bot_key
```

### Permanent Solution (TODO)

For persistent key mounting across restarts, use a volume mount via config directory:

```bash
# Copy key to config directory
cp ~/.ssh/openclaw_bot_key ~/.openclaw/ssh_keys/bot_key
chmod 600 ~/.openclaw/ssh_keys/bot_key

# Update docker-compose.yml volumes (already done, but needs debugging):
# - /home/pi/.ssh/openclaw_bot_key:/home/node/.ssh/bot_key:ro
```

Currently investigating why volume mount doesn't work (might need pre-created directory structure).

---

## 📋 Verification Commands

### Check Key on Host

```bash
ssh pi@192.168.2.134
ls -la ~/.ssh/openclaw_bot_key*
cat ~/.ssh/openclaw_bot_key.pub
```

### Check Key in Container

```bash
ssh pi@192.168.2.134
docker exec moltbot-openclaw-gateway-1 ls -la /home/node/.ssh/bot_key
docker exec moltbot-openclaw-gateway-1 cat /home/node/.ssh/bot_key
```

### Test Key Manually

```bash
ssh pi@192.168.2.134
ssh -i ~/.ssh/openclaw_bot_key pi@192.168.2.134 'hostname && whoami'
```

---

## 🎯 Expected Test Results

When you run the bot test command, you should see:

1. **Session Opens:**

   ```
   SSH session opened successfully.
   Session ID: xxxxxxxx
   Host: 192.168.2.134
   Username: pi
   ```

2. **Commands Execute:**

   ```
   hostname: moltbot-1
   whoami: pi
   pwd: /home/pi
   ```

3. **Session Closes:**
   ```
   SSH session xxxxxxxx closed successfully.
   ```

**Key Difference from Password Auth:**

- ✅ No password prompt
- ✅ No "password" parameter in logs
- ✅ Uses `privateKey` parameter instead

---

## 🚀 Using on Other Servers

To allow the bot to connect to other servers:

### 1. Copy Public Key to Target Server

```bash
ssh pi@192.168.2.134 "cat ~/.ssh/openclaw_bot_key.pub"
# Copy output, then on target server:
echo "ssh-ed25519 AAAA... openclaw-bot@moltbot" >> ~/.ssh/authorized_keys
```

### 2. Bot Command

```
Connect to <other-server-ip> as user '<username>' using the SSH private key from file /home/node/.ssh/bot_key
```

---

## 🔐 Key Revocation

If you need to revoke bot access:

### Remove from authorized_keys

```bash
ssh pi@192.168.2.134
nano ~/.ssh/authorized_keys
# Delete line containing "openclaw-bot@moltbot"
```

### Delete Keys

```bash
rm ~/.ssh/openclaw_bot_key ~/.ssh/openclaw_bot_key.pub
docker exec moltbot-openclaw-gateway-1 rm -f /home/node/.ssh/bot_key
```

---

**Setup Date**: 2026-02-11 11:25 CET
**Key Type**: Ed25519
**Key Fingerprint**: SHA256:... (run `ssh-keygen -lf ~/.ssh/openclaw_bot_key.pub` to see)
**Status**: ✅ Ready for Testing
