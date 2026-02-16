---
summary: "Optional Apple Container-based setup and onboarding for OpenClaw"
read_when:
  - You want to use Apple's native container runtime on macOS
  - You want a lightweight containerized gateway on Apple Silicon
  - You need flexible container runtime support (Docker, Podman, or Apple Container)
title: "Apple Container"
---

# Apple Container (optional)

[Apple Container](https://github.com/apple/container) is a native container runtime for macOS that runs Linux containers in lightweight virtual machines. It is optimized for Apple Silicon and provides a secure, high-performance alternative to Docker Desktop. It uses the same image as Docker (build from the repo Dockerfile).

The setup script also supports **Docker** and **Podman** as fallbacks, making it flexible across different macOS setups.

## Is Apple Container right for me?

- **Yes**: you want a lightweight, native container runtime on Apple Silicon or you're developing OpenClaw in a containerized environment
- **Yes**: you want isolation from your local system but don't want Docker Desktop's resource overhead
- **No**: you're running on your own machine and just want the fastest dev loop. Use the normal install flow instead.
- **No**: you need Docker Compose features or multi-service orchestration. Use [Docker](/install/docker) instead.

**Comparison:**

| Feature | Apple Container | Docker | Local |
|---------|-----------------|--------|-------|
| Native to macOS | ✅ | Via Desktop | N/A |
| Apple Silicon optimized | ✅ | ✅ | N/A |
| Lightweight | ✅ | Medium | N/A |
| Compose support | ❌ | ✅ | N/A |
| Fallback to Docker/Podman | ✅ | N/A | N/A |
| Fastest dev loop | ❌ | ❌ | ✅ |

## Requirements

Choose **one** container runtime:

- **Apple Container** (recommended for macOS):
  - [Apple Container](https://github.com/apple/container) installed
  - Lightweight, native to macOS, optimized for Apple Silicon

Additional requirements:
- macOS (Apple Silicon recommended, Intel supported)
- At least 2GB available RAM for the container
- Enough disk space for images and logs

## Quick start (recommended)

**Before you start:** Make sure you have [Apple Container](https://github.com/apple/container) installed and running. The script will automatically detect it.

From the repository root:

```bash
./apple-container-setup.sh
```

This script will:

1. **Detect your container runtime** — automatically finds `container` (Apple Container), `docker`, or `podman`
2. **Build the gateway image** — creates a local image with all dependencies
3. **Run onboarding wizard** — guides you through initial setup (interactive)
4. **Start the gateway** — launches as a background service
5. **Generate security token** — creates and stores your gateway token

The setup typically takes 5-10 minutes on first run.

**If Apple Container isn't found**, the script will check for Docker or Podman. If you don't have any of these, it will exit with a clear error asking you to install one.

### After setup completes:

1. Open `http://127.0.0.1:18789/` in your browser
2. Paste the token shown in the terminal into the Control UI (Settings → Token)
3. You're ready to use OpenClaw!

Configuration and data are stored on your host at:
- `~/.openclaw/` — configuration files
- `~/.openclaw/workspace` — workspace data

## Configuration via Environment Variables

### Basic Configuration

| Variable | Purpose | Default | Example |
|----------|---------|---------|---------|
| `OPENCLAW_GATEWAY_PORT` | HTTP port for the gateway | `18789` | `export OPENCLAW_GATEWAY_PORT=19000` |
| `OPENCLAW_BRIDGE_PORT` | Bridge service port | `18790` | `export OPENCLAW_BRIDGE_PORT=19001` |
| `OPENCLAW_GATEWAY_BIND` | Network binding mode | `lan` | `lan`, `all`, or IP address |
| `OPENCLAW_IMAGE` | Custom image name/tag | `openclaw:local` | `openclaw:dev` |

### Advanced Configuration

| Variable | Purpose | Example |
|----------|---------|---------|
| `OPENCLAW_CONFIG_DIR` | Config directory on host | `~/.openclaw` |
| `OPENCLAW_WORKSPACE_DIR` | Workspace directory on host | `~/.openclaw/workspace` |
| `OPENCLAW_DOCKER_APT_PACKAGES` | Extra apt packages to install | `git curl` |
| `OPENCLAW_EXTRA_MOUNTS` | Additional volume mounts | `/data:/home/node/data,/logs:/home/node/logs` |
| `OPENCLAW_HOME_VOLUME` | Docker volume for `/home/node` | `openclaw-home` |

### Authentication Variables

These are automatically detected from your environment:

| Variable | Purpose |
|----------|---------|
| `CLAUDE_AI_SESSION_KEY` | Claude AI session authentication |
| `CLAUDE_WEB_SESSION_KEY` | Claude Web session authentication |
| `CLAUDE_WEB_COOKIE` | Claude Web cookie for authentication |

## Usage Examples

### Example 1: Custom Port with Extra Packages

```bash
export OPENCLAW_GATEWAY_PORT=19000
export OPENCLAW_DOCKER_APT_PACKAGES="git curl wget"
./apple-container-setup.sh
```

Then access at `http://127.0.0.1:19000/`

### Example 2: Mount Additional Directories

```bash
export OPENCLAW_EXTRA_MOUNTS="/Users/you/data:/home/node/data,/Users/you/logs:/home/node/logs"
./apple-container-setup.sh
```

Inside the container:
- `/Users/you/data` → accessible at `/home/node/data`
- `/Users/you/logs` → accessible at `/home/node/logs`

### Example 3: Persistent Home Volume

```bash
export OPENCLAW_HOME_VOLUME="openclaw-home"
./apple-container-setup.sh
```

The `/home/node` directory persists in a Docker volume across container restarts.

### Example 4: Bind to All Interfaces

```bash
export OPENCLAW_GATEWAY_BIND="all"
./apple-container-setup.sh
```

The gateway is accessible from any network interface (useful for remote access).

## Managing the Gateway

### View logs

```bash
container logs -f openclaw-gateway
# or: docker logs -f openclaw-gateway
# or: podman logs -f openclaw-gateway
```

### Check health

```bash
container exec openclaw-gateway node dist/index.js health --token "YOUR_TOKEN_HERE"
```

Replace `YOUR_TOKEN_HERE` with the token from `.env`

### Stop the gateway

```bash
container stop openclaw-gateway
```

### Remove the container

```bash
container rm openclaw-gateway
```

### Restart the gateway

```bash
container restart openclaw-gateway
```

## Manual / Advanced Flow

If you prefer full control over the setup:

```bash
# Build the image
container build -t openclaw:local -f Dockerfile .

# Run onboarding
container run --rm -it \
  -v ~/.openclaw:/home/node/.openclaw \
  -v ~/.openclaw/workspace:/home/node/.openclaw/workspace \
  openclaw:local node dist/index.js onboard --no-install-daemon

# Start the gateway
container run -d --name openclaw-gateway \
  -p 18789:18789 \
  -p 18790:18790 \
  -v ~/.openclaw:/home/node/.openclaw \
  -v ~/.openclaw/workspace:/home/node/.openclaw/workspace \
  openclaw:local node dist/index.js gateway --bind lan
```

## Container Runtime Detection

The setup script automatically detects available container runtimes in this priority order:

1. **Apple Container** (preferred) — `container` command
   - If found: uses Apple Container for everything
   - Fast, lightweight, native to macOS

2. **Docker** (fallback) — `docker` command
   - If Apple Container not found but Docker is available
   - Uses Docker if you already have Docker Desktop installed

3. **Podman** (fallback) — `podman` command
   - If Apple Container and Docker not found but Podman is available
   - Uses Podman as a rootless alternative

**If none are found**, the script exits with a clear error:
```
Error: No container runtime found. Install 'container', 'docker', or 'podman'
```

**Recommendation:** Install Apple Container for the best experience on macOS. You don't need Docker or Podman unless you're already using them.

## Performance Tips

### Memory Configuration

The default memory limit is 2GB. Adjust if needed:

```bash
# Edit the script or set before running
# The gateway typically uses 500MB-1GB
```

### Building Images

First build is slower (downloads base image). Subsequent builds are fast due to Docker's caching.

```bash
# Full rebuild (skips cache)
container build --no-cache -t openclaw:local -f Dockerfile .
```

### Network Binding

- `lan` (default) — accessible from your local network
- `all` — accessible from any network (less secure)
- Specific IP — bind to a specific interface

## Control UI token + pairing (Apple Container)

If you see "unauthorized" or "disconnected (1008): pairing required", fetch a fresh dashboard link and approve the browser device:

```bash
container exec openclaw-gateway node dist/index.js dashboard --no-open
container exec openclaw-gateway node dist/index.js devices list
container exec openclaw-gateway node dist/index.js devices approve <requestId>
```

More detail: [Dashboard](/web/dashboard), [Devices](/cli/devices).

## Channel setup (optional)

Use the gateway container to configure channels, then restart if needed.

**WhatsApp (QR):**

```bash
container exec openclaw-gateway node dist/index.js channels login
```

**Telegram (bot token):**

```bash
container exec openclaw-gateway node dist/index.js channels add --channel telegram --token "<token>"
```

**Discord (bot token):**

```bash
container exec openclaw-gateway node dist/index.js channels add --channel discord --token "<token>"
```

Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

## Power-user / full-featured container (opt-in)

The default container image is **security-first** and runs as the non-root `node` user. This keeps the attack surface small, but it means:

- no system package installs at runtime
- no Homebrew by default
- no bundled Chromium/Playwright browsers

If you want a more full-featured container, use these opt-in knobs:

1. **Persist `/home/node`** so browser downloads and tool caches survive:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./apple-container-setup.sh
```

2. **Bake system deps into the image** (repeatable + persistent):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq ffmpeg"
./apple-container-setup.sh
```

3. **Install Playwright browsers** (avoid npm override conflicts):

```bash
container exec openclaw-gateway node /app/node_modules/playwright-core/cli.js install chromium
```

If you need Playwright to install system deps, rebuild the image with `OPENCLAW_DOCKER_APT_PACKAGES` instead of using `--with-deps` at runtime.

4. **Persist Playwright browser downloads**:

Set these environment variables before running setup:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="chromium"
export OPENCLAW_HOME_VOLUME="openclaw_home"
./apple-container-setup.sh
```

Then configure in your gateway config:

```json5
{
  browser: {
    cacheDir: "/home/node/.cache/ms-playwright"
  }
}
```

## Permissions + EACCES

The container runs as `node` (uid 1000). If you see permission errors on `/home/node/.openclaw`, make sure your host bind mounts are readable:

```bash
# Check permissions
ls -la ~/.openclaw
chmod 755 ~/.openclaw ~/.openclaw/workspace
```

If you choose to run as root for convenience, you accept the security tradeoff.

## Faster rebuilds (recommended)

To speed up rebuilds, ensure your Dockerfile layers are cached properly. The image should follow this pattern:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

**Tips:**

- Dependency layers are cached unless lockfiles change
- Avoids re-running `pnpm install` on code-only changes
- First build is slower (downloads base image); subsequent builds are fast

To force a full rebuild:

```bash
container build --no-cache -t openclaw:local -f Dockerfile .
```

## OpenAI Codex OAuth (headless Container)

If you pick OpenAI Codex OAuth in the wizard, it opens a browser URL and tries to capture a callback on `http://127.0.0.1:1455/auth/callback`. In containerized or headless setups, that callback can show a browser error. Copy the full redirect URL you land on and paste it back into the wizard to finish auth.

## Health check

```bash
container exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

Replace `$OPENCLAW_GATEWAY_TOKEN` with the token from `.env`

## Agent Sandbox (container-based tool isolation)

Deep dive: [Sandboxing](/gateway/sandboxing)

**Note:** Agent sandboxing is currently a Docker-specific feature. If you use Apple Container as your gateway runtime and need tool sandboxing, you have two options:

1. **Use Docker for sandboxing** (recommended): Run your gateway in Apple Container and configure sandboxing to use Docker for tool execution
2. **Switch to Docker gateway**: Use [Docker](/install/docker) for both the gateway and sandboxing

Sandboxing provides:
- Per-session or per-agent Docker containers for tool execution
- Isolated filesystem, network, and process environments
- Tool allowlist/denylist policies
- Memory, CPU, and PID limits per container

For configuration details, see [Agent Sandbox](/gateway/sandboxing).

## Troubleshooting

### `container` command not found

**Apple Container:**
```bash
# Install from https://github.com/apple/container
# Then start the service:
container system start
```

**Alternative: Use Docker or Podman instead**
```bash
# The script automatically detects docker or podman
# Just make sure one is installed and running
brew install docker podman
```

### Port conflicts

If port 18789 is already in use:

```bash
# Find what's using the port
lsof -i :18789

# Use a different port
export OPENCLAW_GATEWAY_PORT=19000
./apple-container-setup.sh
```

### Container runtime not responding

The script detected a runtime but it's not currently running. Start it:

**Apple Container:**
```bash
container system start
```

**Docker** (if that's what you're using):
```bash
open -a Docker
```

**Podman** (if that's what you're using):
```bash
podman system service --time=0
```

### Permission errors on volume mounts

Ensure paths exist and are readable:

```bash
# Create directories if they don't exist
mkdir -p ~/.openclaw ~/.openclaw/workspace

# Check permissions
ls -la ~/.openclaw
ls -la ~/.openclaw/workspace

# If needed, fix permissions
chmod 755 ~/.openclaw ~/.openclaw/workspace
```

### Browser can't connect to gateway

```bash
# Check if container is running
container ps | grep openclaw-gateway

# Check if port is actually listening
lsof -i :18789

# View logs for errors
container logs openclaw-gateway
```

### Out of disk space

The container image and logs can consume disk space:

```bash
# Check disk usage
du -sh ~/.openclaw
du -sh ~/.openclaw/workspace

# Clean up old images
container image prune -a

# View container logs size
container logs openclaw-gateway | wc -c
```

### Onboarding wizard hangs

The onboarding has a 5-minute timeout. If it hangs:

```bash
# Kill the hanging container
container rm -f openclaw-gateway-temp

# Try again with explicit non-interactive mode
container run --rm \
  -v ~/.openclaw:/home/node/.openclaw \
  -v ~/.openclaw/workspace:/home/node/.openclaw/workspace \
  openclaw:local node dist/index.js onboard --no-install-daemon
```

## Resetting Configuration

To start fresh:

```bash
# Stop and remove the container
container rm -f openclaw-gateway

# Remove local configuration (WARNING: this is destructive)
rm -rf ~/.openclaw

# Run setup again
./apple-container-setup.sh
```

## Advanced: Custom Build Args

Install additional packages during image build:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="postgresql-client redis-tools netcat"
./apple-container-setup.sh
```

These packages are available inside the container for use by OpenClaw agents.

## Performance Comparison

| Runtime | Startup | Memory | Apple Silicon | Notes |
|---------|---------|--------|---|----------|
| Apple Container | ~2s | 500MB | Excellent | Native, optimized |
| Docker | ~3s | 600MB | Good | Widely compatible |
| Podman | ~2s | 500MB | Good | Rootless option |

## Next Steps

After successful setup:

1. Open the gateway UI at `http://127.0.0.1:18789/`
2. Configure channels in Settings
3. Add authentication credentials for services
4. Start automating with OpenClaw agents
