# Fork Maintenance Guide

This document helps ensure your fork's configuration stays correct after updates.

## Current Working Configuration

**Service File:** `~/.config/systemd/user/openclaw-gateway.service`

- **ExecStart:** `/usr/bin/node /root/projects/openclaw-fork/dist/index.js gateway run --port 18789`
- **Environment Variables:**
  - `OLLAMA_HOST=https://ollama.com`
  - `OLLAMA_API_KEY=...` (your key)

**Repository Path:** `/root/projects/openclaw-fork`

## Update Checklist

When pulling updates or rebuilding:

### 1. **Never run these commands** (they will overwrite your custom setup):

```bash
# ❌ DON'T RUN - overwrites your custom service file
openclaw gateway install
openclaw onboard --install-daemon

# ❌ DON'T RUN - installs global npm version that conflicts
npm i -g openclaw@latest
sudo npm i -g openclaw@latest

# ⚠️ USE WITH CAUTION - can overwrite your custom service file
# openclaw doctor
#
# Doctor checks if your service entrypoint matches what it expects.
# If it detects a mismatch (e.g., your fork path vs. global install),
# it will prompt to "Update gateway service config to the recommended defaults".
# If you say yes, it will OVERWRITE your custom service file!
#
# If you must run doctor, use --no-repair or carefully review what it wants to change.
```

### 2. **Safe update workflow:**

```bash
cd /root/projects/openclaw-fork

# Pull latest changes
git pull --rebase

# ⚠️ CRITICAL: Stop the service BEFORE rebuilding
# The running process has old code loaded in memory. If you rebuild while it's running,
# the process will continue using the old code even though files on disk are updated.
systemctl --user stop openclaw-gateway.service

# Wait for it to fully stop
sleep 2

# Rebuild dist/ (CRITICAL - always do this after git pull)
# This includes copying data files like skills.json
pnpm install
pnpm build

# Verify the build includes your changes
grep -R "Is Ollama reachable at" dist/ | head -1

# Start the service (uses your custom service file)
systemctl --user start openclaw-gateway.service

# Verify it's running your fork
ps aux | grep -E "openclaw.*dist/index.js" | grep -v grep
```

### 3. **Verify after restart:**

```bash
# Check logs for the new warning format (if discovery fails)
journalctl --user -u openclaw-gateway.service -n 50 | grep -i ollama

# Should see: "Is Ollama reachable at https://ollama.com? (Set OLLAMA_HOST...)"
# NOT just: "Failed to discover Ollama models: TypeError: fetch failed"

# Verify models are discovered
openclaw models list | grep -i ollama
```

## How Your Service File Can Get Overwritten

**The Mystery Solved:** Even if you only run `pnpm install` and `pnpm build`, your service file can still get overwritten if you (or something) runs:

- **`openclaw doctor`** - This command audits your service configuration and can detect that your custom `ExecStart` path doesn't match what it expects (e.g., your fork path vs. a global install path). When it finds a mismatch, it prompts: _"Update gateway service config to the recommended defaults now?"_ If you answer yes (or if it auto-confirms), it calls `service.install()` which **overwrites** your custom service file.

- **`openclaw gateway install`** - Explicitly reinstalls the service with default paths.

- **`openclaw onboard --install-daemon`** - Onboarding wizard that installs the service.

**What likely happened:** You may have run `openclaw doctor` at some point (it's recommended in the docs for updates), and it detected your fork path didn't match the expected global install path, then offered to "fix" it by overwriting your custom configuration.

## Protection Mechanisms

### Backup your service file:

```bash
# Create a backup
cp ~/.config/systemd/user/openclaw-gateway.service \
   ~/.config/systemd/user/openclaw-gateway.service.backup
```

### Verify service file hasn't changed:

```bash
# Check ExecStart still points to your fork
systemctl --user cat openclaw-gateway.service | grep ExecStart

# Should show: ExecStart=/usr/bin/node /root/projects/openclaw-fork/dist/index.js ...
```

### Prevent accidental global installs:

```bash
# Check if global npm version exists (and remove if needed)
npm list -g openclaw 2>/dev/null || echo "No global npm install found (good)"

# If it exists and you want to remove it:
# sudo npm uninstall -g openclaw
```

### Protect against `openclaw doctor` overwrites:

If you need to run `openclaw doctor` for other checks (config migrations, etc.) but want to preserve your service file:

```bash
# Option 1: Run doctor but skip service repairs
# (Check if doctor has a --no-repair flag or similar)

# Option 2: Backup first, then restore if needed
cp ~/.config/systemd/user/openclaw-gateway.service \
   ~/.config/systemd/user/openclaw-gateway.service.backup
openclaw doctor
# If service file changed, restore it:
# cp ~/.config/systemd/user/openclaw-gateway.service.backup \
#    ~/.config/systemd/user/openclaw-gateway.service
# systemctl --user daemon-reload
# systemctl --user restart openclaw-gateway.service
```

## Troubleshooting

### If you see old warning messages:

1. **Check which binary is running:**

   ```bash
   ps aux | grep openclaw-gateway | grep -v grep
   ```

2. **Verify service file:**

   ```bash
   systemctl --user cat openclaw-gateway.service | grep ExecStart
   ```

3. **Rebuild dist/ if needed:**

   ```bash
   cd /root/projects/openclaw-fork

   # Stop first (CRITICAL - see note above)
   systemctl --user stop openclaw-gateway.service
   sleep 2

   # Clean rebuild
   rm -rf dist
   pnpm build

   # Start fresh
   systemctl --user start openclaw-gateway.service
   ```

### If `openclaw` command resolves to wrong binary:

```bash
which openclaw
# Should point to: /root/.local/share/pnpm/openclaw (pnpm shim)
# NOT: /usr/bin/openclaw or /usr/local/bin/openclaw
```

## Quick Health Check Script

Save this as `~/check-openclaw-fork.sh`:

```bash
#!/bin/bash
echo "=== OpenClaw Fork Health Check ==="
echo

echo "1. Service file ExecStart:"
systemctl --user cat openclaw-gateway.service 2>/dev/null | grep ExecStart | head -1
echo

echo "2. Running process:"
ps aux | grep -E "openclaw.*dist/index.js" | grep -v grep || echo "❌ Not running fork!"
echo

echo "3. Built code has new Ollama message:"
grep -q "Is Ollama reachable at" /root/projects/openclaw-fork/dist/*.js 2>/dev/null && echo "✓ Found" || echo "❌ Not found - rebuild needed"
echo

echo "4. Environment variables:"
systemctl --user show openclaw-gateway.service | grep OLLAMA_HOST
echo

echo "5. Recent logs (last Ollama warning):"
journalctl --user -u openclaw-gateway.service -n 100 | grep -i "ollama" | tail -1
```

Make it executable: `chmod +x ~/check-openclaw-fork.sh`
