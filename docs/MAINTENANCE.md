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

### 1. **Never run these commands** (they will overwrite your custom setup)

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

## Build-phase race (gateway or cron during `pnpm build`)

The build script is **non-atomic**: `tsdown` used to clean the entire `dist/` directory at the start, and `copy-skills-data.ts` restores `dist/data/skills.json` only at the end. That created a ~20–40 second window where `dist/` was empty. If the gateway was running (or a cron job fired) during that window, the prompt engine hit ENOENT when loading the skills library.

**Fixes applied in this fork:**

1. **No-clean build** — `tsdown.config.ts` sets `clean: false` so the output directory is **not** wiped before build. Existing files (including `dist/data/skills.json`) stay until overwritten. `copy-skills-data.ts` still runs at the end and overwrites `skills.json`, so there is no empty-window race.
2. **Eager-load at gateway boot** — The gateway calls `SkillsLoader.loadLibrary()` once during startup and caches the result in memory. So even if a build runs later and removes the file from disk, the **running** process keeps using the in-memory copy until the next restart.
3. **Retry on ENOENT** — If the first load fails because all paths are missing (e.g. a build started just before boot), the loader retries for a short window instead of immediately returning an empty library.

**Recommendation:** Still stop the gateway before a full build when possible (`systemctl --user stop openclaw-gateway.service` then `pnpm build` then start). That avoids the process holding old code in memory. The above measures make it safe if you forget to stop.

## Why skills.json Can Disappear (git clean / agent)

If the OpenClaw **agent** is asked to run a "status" or "check" on the system and its **workspace is the fork repo** (`/root/projects/openclaw-fork`), it may run shell commands such as:

- **`git status`** followed by **`git clean -fd`** (to "clean untracked files")
- Or a custom script that removes `dist/` or runs a partial build

Because **`dist/` is gitignored**, `git clean -fd` removes the entire `dist/` tree, including `dist/data/skills.json` and `dist/agents/prompt-engine/data/skills.json`. The gateway then fails with ENOENT when loading the skills registry.

**What to do:**

1. **Avoid:** Do not run `git clean -fd` (or `git clean -fdx`) inside the fork repo. If the agent's workspace is the repo, avoid asking it to "clean the repo" or run destructive git commands there.
2. **Restore:** Run a full build so the copy step repopulates `dist/`:

   ```bash
   cd /root/projects/openclaw-fork
   systemctl --user stop openclaw-gateway.service
   pnpm build
   systemctl --user start openclaw-gateway.service
   ```

3. **Resolution order:** The gateway looks for `skills.json` in this order: (1) `dist/data/skills.json` when the process is started as `node dist/index.js` (canonical for bundled/production), (2) same-directory-as-loader `data/skills.json`, (3) **source** path `src/agents/prompt-engine/data/skills.json` if the dist copy is missing. So if only `dist/` was wiped (repo intact), the gateway may still start and you will see: `Loaded skills from source path (dist copy missing)`.

## Agent exec and missing skill dirs

If you see a log line like:

```text
error [tools] exec failed: ls: cannot access '/root/projects/openclaw-fork/skills/bird/': No such file or directory
```

the **agent** ran a shell command (e.g. `ls …/skills/bird/`) via the exec tool. That path does not exist on the machine (e.g. the optional **bird** skill is not installed or not in that workspace). This error **does not remove skills**; it only means that one exec tool call failed because the path was missing.

- **Why it happens:** The agent may be following docs or prompts that mention a skill (e.g. bird) and tries to list or inspect that skill’s directory. If the skill is optional and not present in the repo or workspace, the command fails.
- **What to do:** Ignore the error if you do not need that skill. To use the skill, install it (e.g. via ClawHub) into the workspace or `~/.openclaw/skills/`. Skill sync into sandboxes now skips entries whose source directory is missing, so a missing skill dir will not break syncing of other skills.

## Tool-level concurrency locks for CLI-backed skills

OpenClaw is inherently multi-agent; scheduled Waves can cause several agents to hit the same CLI-backed tool at the exact same time (for example a Twitter/X client or email CLI). Many of these CLIs are effectively **singletons** on the host and will fail if multiple processes try to use the same config/database/socket concurrently.

### Behavior in this fork

This fork adds a **per-tool-name semaphore** for plugin tools (skills) that shell out to such CLIs. When enabled for a given tool name, the gateway:

- **Serializes tool calls within the gateway process** (only one `execute` per tool name runs at a time).
- **Queues concurrent calls** instead of failing fast with "Command exited with code 1".
- Releases the lock as soon as the underlying CLI call finishes so the next waiting agent can proceed.

By default, no tools are treated as singletons; concurrency only changes when you turn this on via configuration.

### Configuration: `OPENCLAW_SINGLETON_TOOLS`

Singleton behavior is controlled by an environment variable on the gateway process:

- **Variable**: `OPENCLAW_SINGLETON_TOOLS`
- **Format**: comma-separated list of tool names (normalized in the same way as other tool policy keys).
- **Scope**: applies to **plugin tools only** (skills loaded via `src/plugins/tools.ts`).

Example:

```bash
export OPENCLAW_SINGLETON_TOOLS="bird,himalaya"
systemctl --user restart openclaw-gateway.service
```

With this set:

- Any plugin tool named `bird` or `himalaya` is executed under a per-name lock.
- Waves where multiple agents want to use those tools will queue briefly instead of colliding at the CLI layer.

You can adjust the list over time without code changes; just update the env var and restart the gateway.

## Discord WebSocket recovery (transient disconnects)

If the Discord gateway WebSocket disconnects briefly (e.g. 1006) during long-running tools, this fork queues outbound replies instead of dropping them. When the connection recovers, queued replies flush automatically. Logs show `discord: reconnected — flushed N queued repl[ies]` when this happens. No action needed. See [Discord troubleshooting](/channels/discord#troubleshooting). Implementation details are in FORK-CHANGES.md (repo root).

## Protection Mechanisms

### Backup your service file

```bash
# Create a backup
cp ~/.config/systemd/user/openclaw-gateway.service \
   ~/.config/systemd/user/openclaw-gateway.service.backup
```

### Verify service file hasn't changed

```bash
# Check ExecStart still points to your fork
systemctl --user cat openclaw-gateway.service | grep ExecStart

# Should show: ExecStart=/usr/bin/node /root/projects/openclaw-fork/dist/index.js ...
```

### Uninstall non-forked (global) OpenClaw

Removing the global npm install prevents `openclaw doctor` (or any script using the global binary) from ever "fixing" your service back to the non-fork path. Do this on the VPS:

**Step 1 — Confirm gateway is using the fork**

```bash
systemctl --user cat openclaw-gateway.service | grep ExecStart
# Must show: ExecStart=/usr/bin/node /root/projects/openclaw-fork/dist/index.js ...
```

**Step 2 — Uninstall the global npm package**

```bash
sudo npm uninstall -g openclaw
```

**Step 3 — Verify it’s gone**

```bash
npm list -g openclaw 2>/dev/null || echo "Not installed (expected)"
ls /usr/lib/node_modules/openclaw 2>/dev/null || echo "Gone (expected)"
```

**Step 4 — Make sure `openclaw` in your shell runs the fork**

You use `openclaw gateway restart` and `openclaw logs`, so the `openclaw` command must point at the fork.

- If `which openclaw` is already something like `/root/.local/share/pnpm/openclaw` and that pnpm global is your fork, you’re done.
- Otherwise, use the fork explicitly from the repo:

  ```bash
  cd /root/projects/openclaw-fork
  pnpm openclaw gateway restart
  pnpm openclaw logs --follow
  ```

  Or make the fork the default `openclaw` for your user (from the repo directory):

  ```bash
  cd /root/projects/openclaw-fork
  pnpm link --global
  # Then: openclaw --version  (should match your fork, e.g. 2026.2.6-3)
  ```

**Step 5 — Quick check**

```bash
openclaw gateway restart
openclaw logs --max-bytes 500
```

After this, only the fork is installed; doctor (if you run it via the fork) will no longer try to point the service at a global path.

### Prevent accidental global installs (ongoing)

```bash
# Check if global npm version exists (and remove if needed)
npm list -g openclaw 2>/dev/null || echo "No global npm install found (good)"
```

### Protect against `openclaw doctor` overwrites

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

### If you see old warning messages

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

### If `openclaw` command resolves to wrong binary

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
