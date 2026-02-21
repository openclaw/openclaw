# Docker Browser Setup Guide for OpenClaw

This guide explains how to set up and use the browser functionality in OpenClaw when running in Docker.

## Overview

The setup consists of:
1. **Sandbox Browser Image** - A dedicated Docker container running Chromium with CDP (Chrome DevTools Protocol) access
2. **Browser Service** - Added to `docker-compose.yml` for easy management
3. **OpenClaw Configuration** - Configure OpenClaw to use the sandbox browser

## Prerequisites

- Docker and Docker Compose installed
- OpenClaw Docker image built (`openclaw:local`)
- Sufficient disk space (~2GB for browser image)

## Step 1: Build the Sandbox Browser Image

```bash
./scripts/sandbox-browser-setup.sh
```

This builds the `openclaw-sandbox-browser:bookworm-slim` image with:
- Chromium browser
- Xvfb (X Virtual Framebuffer) for display
- x11vnc + noVNC for web-based viewing
- socat for CDP port forwarding

## Step 2: Update docker-compose.yml

The `docker-compose.yml` has been updated with a new `openclaw-browser` service:

```yaml
openclaw-browser:
  image: openclaw-sandbox-browser:bookworm-slim
  ports:
    - "${OPENCLAW_BROWSER_CDP_PORT:-9222}:9222"
    - "${OPENCLAW_BROWSER_VNC_PORT:-5900}:5900"
    - "${OPENCLAW_BROWSER_NOVNC_PORT:-6080}:6080"
  environment:
    OPENCLAW_BROWSER_HEADLESS: "${OPENCLAW_BROWSER_HEADLESS:-0}"
    OPENCLAW_BROWSER_ENABLE_NOVNC: "${OPENCLAW_BROWSER_ENABLE_NOVNC:-1}"
  restart: unless-stopped
```

## Step 3: Configure Environment Variables (Optional)

Add to your `.env` file:

```bash
# Browser ports
OPENCLAW_BROWSER_CDP_PORT=9222
OPENCLAW_BROWSER_VNC_PORT=5900
OPENCLAW_BROWSER_NOVNC_PORT=6080

# Browser mode
OPENCLAW_BROWSER_HEADLESS=0      # Set to 1 for headless mode
OPENCLAW_BROWSER_ENABLE_NOVNC=1  # Set to 0 to disable noVNC
```

## Step 4: Start the Browser Service

```bash
# Start all services
docker compose up -d

# Start only the browser
docker compose up -d openclaw-browser
```

## Step 5: Configure OpenClaw to Use the Browser

Edit `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: { enabled: true }
      }
    }
  }
}
```

For remote browser (recommended for Docker):

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "docker-browser",
    profiles: {
      "docker-browser": {
        cdpUrl: "http://openclaw-browser:9222",
        color: "#00AA00"
      }
    }
  }
}
```

For sandbox browser mode:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: { enabled: true }
      }
    }
  }
}
```

## Step 6: Restart Gateway

```bash
docker compose restart openclaw-gateway
```

## Step 7: Verify Browser Setup

```bash
# Check browser status via CLI
docker compose run --rm openclaw-cli browser status

# Check if browser container is running
docker compose ps openclaw-browser

# Test browser access
curl http://localhost:9222/json/version
```

## Accessing the Browser

### CDP (Chrome DevTools Protocol)
- Port: `9222` (default)
- URL: `http://localhost:9222`

### noVNC (Web-based Viewer)
- Port: `6080` (default)
- URL: `http://localhost:6080/vnc.html`

### VNC
- Port: `5900` (default)
- Use any VNC client

## Usage Examples

### CLI Commands

```bash
# Open a URL
docker compose run --rm openclaw-cli browser open https://example.com

# Take a snapshot
docker compose run --rm openclaw-cli browser snapshot

# Take a screenshot
docker compose run --rm openclaw-cli browser screenshot

# List tabs
docker compose run --rm openclaw-cli browser tabs
```

### Agent Usage

When sandboxing is enabled, agents can automatically use the browser tool:

```
User: Open https://example.com and take a screenshot

Agent: [Uses browser tool to open the URL and capture screenshot]
```

## Troubleshooting

### Browser container not starting

```bash
# Check logs
docker compose logs openclaw-browser

# Rebuild the image
./scripts/sandbox-browser-setup.sh
```

### Cannot connect to browser

1. Verify the container is running: `docker compose ps`
2. Check ports: `docker compose port openclaw-browser 9222`
3. Test CDP endpoint: `curl http://localhost:9222/json/version`

### Browser tool disabled

1. Enable in config: `agents.defaults.sandbox.browser.enabled = true`
2. Restart gateway: `docker compose restart openclaw-gateway`
3. Check tool policy: ensure `browser` is not in the deny list

### noVNC not accessible

1. Check if noVNC is enabled: `OPENCLAW_BROWSER_ENABLE_NOVNC=1`
2. Verify port mapping: `docker compose port openclaw-browser 6080`
3. Check browser is not headless: `OPENCLAW_BROWSER_HEADLESS=0`

## Advanced Configuration

### Custom Browser Image

```bash
docker build -t my-openclaw-browser -f Dockerfile.sandbox-browser .
```

Update `docker-compose.yml`:
```yaml
openclaw-browser:
  image: my-openclaw-browser
```

### Resource Limits

```yaml
openclaw-browser:
  image: openclaw-sandbox-browser:bookworm-slim
  deploy:
    resources:
      limits:
        cpus: '2'
        memory: 2G
      reservations:
        cpus: '1'
        memory: 1G
```

### Headless Mode

Set in `.env`:
```bash
OPENCLAW_BROWSER_HEADLESS=1
```

This disables Xvfb and noVNC, running Chromium in headless mode only.

## Network Configuration

By default, the browser uses the default Docker network. To use a custom network:

```yaml
openclaw-browser:
  image: openclaw-sandbox-browser:bookworm-slim
  networks:
    - openclaw-net

networks:
  openclaw-net:
    external: true
```

## Security Notes

1. **CDP Port**: The CDP port (9222) is powerful. Keep it private or use a firewall.
2. **VNC/noVNC**: Consider disabling noVNC if you don't need visual debugging.
3. **Sandboxing**: The browser container runs as root for Xvfb compatibility. Consider hardening for production.

## Cleanup

```bash
# Stop browser service
docker compose down openclaw-browser

# Remove browser image
docker rmi openclaw-sandbox-browser:bookworm-slim

# Clean up volumes
docker volume rm openclaw_home
```

## Documentation Links

- Docker Setup: https://docs.openclaw.ai/install/docker
- Browser Tool: https://docs.openclaw.ai/tools/browser
- Sandboxing: https://docs.openclaw.ai/gateway/sandboxing
