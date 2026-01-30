# 🔐 Hardened Docker Configuration

## What Changed

### 1. OpenClaw Configuration (`~/.clawdbot/clawdbot.json`)

✅ **Added Nested Sandboxing** - Tools now run in isolated Docker containers:
- `mode: "non-main"` - Sandboxes group chats and non-main sessions
- `scope: "session"` - Each session gets its own container
- `workspaceAccess: "none"` - No direct workspace access (safer)
- `network: "none"` - Sandboxed tools have no network access
- `readOnlyRoot: true` - Sandboxed containers have read-only root filesystem
- **Bind mounts**: Documents and Downloads are available read-only at `/documents` and `/downloads`

✅ **Added Session Isolation**:
- `session.dmScope: "per-channel-peer"` - Each DM sender gets isolated session
- Prevents cross-user context leakage

### 2. Docker Compose Security Hardening

✅ **Container Security**:
- `no-new-privileges:true` - Prevents privilege escalation
- `cap_drop: ALL` - Drops all capabilities
- `cap_add: [CHOWN, SETGID, SETUID]` - Only adds necessary capabilities
- `read_only: true` - Read-only root filesystem
- `tmpfs` - Temporary writable /tmp with noexec/nosuid

✅ **Resource Limits**:
- Max 2 CPU cores
- Max 2GB RAM
- Reserves 0.5 CPU / 512MB minimum

✅ **Volume Mounts** (Read-Only):
- Documents: `/c/Users/grumb/Documents` → `/home/node/documents:ro`
- Downloads: `/c/Users/grumb/Downloads` → `/home/node/downloads:ro`

## How to Apply

### Step 1: Rebuild and Restart

```bash
# Stop current containers
docker compose down

# Rebuild the image (if needed)
docker compose build

# Start with hardened config
docker compose up -d clawdbot-gateway
```

### Step 2: Build Sandbox Image (Required for nested sandboxing)

```bash
# Build the sandbox image that will be used for tool isolation
./scripts/sandbox-setup.sh

# Verify it was built
docker images | grep clawdbot-sandbox
```

### Step 3: Test Access to Your Files

Your Documents and Downloads are now available inside the container at:
- `/home/node/documents` (read-only)
- `/home/node/downloads` (read-only)

And inside sandboxed tools at:
- `/documents` (read-only)
- `/downloads` (read-only)

Test it:
```bash
docker compose exec clawdbot-cli ls -la /home/node/documents
docker compose exec clawdbot-cli ls -la /home/node/downloads
```

### Step 4: Verify Sandboxing Works

Start a non-main session (e.g., in a WhatsApp group) and run a tool. You should see:
- A new Docker container spawned for the tool execution
- Container name like `clawdbot-sbx-<session-id>`
- Check with: `docker ps | grep clawdbot-sbx`

## Security Improvements

| Before | After |
|--------|-------|
| Tools run in main container | Tools run in isolated containers |
| All DMs share one session | Each DM sender gets isolated session |
| Documents/Downloads: read-write | Documents/Downloads: read-only |
| Container has many capabilities | Container drops all unnecessary capabilities |
| Root filesystem writable | Root filesystem read-only |
| No resource limits | CPU/memory limits enforced |

## Maintenance

### Viewing Sandbox Containers
```bash
# List active sandboxes
docker ps --filter "name=clawdbot-sbx"

# Clean up stopped sandboxes
docker container prune --filter "name=clawdbot-sbx"
```

### Updating the Sandbox Image
If you update OpenClaw or need new packages in sandboxes:
```bash
./scripts/sandbox-setup.sh
docker compose restart clawdbot-gateway
```

### Troubleshooting

**Issue**: "Cannot access Documents/Downloads in sandbox"
- Check: `docker compose exec clawdbot-gateway ls -la /home/node/documents`
- Ensure paths in `docker-compose.extra.yml` match your system

**Issue**: "Sandbox containers fail to start"
- Check Docker socket access: The container needs Docker access to spawn sandboxes
- Verify sandbox image exists: `docker images | grep clawdbot-sandbox`
- Check logs: `docker compose logs clawdbot-gateway | grep -i sandbox`

**Issue**: "Tools can't write to Documents/Downloads"
- This is by design! They're mounted read-only for security.
- If you need write access, change `:ro` to `:rw` in docker-compose files (not recommended)
- Better: Work in the workspace (`/home/node/clawd`) which is writable

## Rollback

If you need to revert:

1. Restore original config:
   ```bash
   cp ~/.clawdbot/clawdbot.json.bak ~/.clawdbot/clawdbot.json
   ```

2. Remove hardened compose:
   ```bash
   rm docker-compose.hardened.yml
   ```

3. Restore original extra mounts:
   ```bash
   # Edit docker-compose.extra.yml to remove read_only and security_opt
   ```

4. Restart:
   ```bash
   docker compose down && docker compose up -d
   ```

---

**Note**: With these changes, tools can READ from your Documents/Downloads but cannot WRITE to them. They can still write to the workspace directory (`/home/node/clawd`). This is the secure configuration.
