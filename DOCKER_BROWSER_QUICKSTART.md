# Quick Start: Docker Browser for OpenClaw

## TL;DR - Fast Setup

```bash
# 1. Build the browser image (takes ~5-10 minutes)
./scripts/sandbox-browser-setup.sh

# 2. Start the browser service
docker compose up -d openclaw-browser

# 3. Configure OpenClaw to use sandbox browser
docker compose run --rm openclaw-cli config set agents.defaults.sandbox.mode non-main
docker compose run --rm openclaw-cli config set agents.defaults.sandbox.browser.enabled true

# 4. Restart gateway to apply config
docker compose restart openclaw-gateway

# 5. Verify
docker compose run --rm openclaw-cli browser --browser-profile openclaw status
```

## Access Points

- **CDP**: http://localhost:9222
- **noVNC**: http://localhost:6080/vnc.html
- **VNC**: localhost:5900

## CLI Quick Commands

```bash
# Browser status
docker compose run --rm openclaw-cli browser status

# Open URL
docker compose run --rm openclaw-cli browser open https://example.com

# Snapshot
docker compose run --rm openclaw-cli browser snapshot

# Screenshot
docker compose run --rm openclaw-cli browser screenshot

# List tabs
docker compose run --rm openclaw-cli browser tabs
```

## Environment Variables (.env)

```bash
OPENCLAW_BROWSER_CDP_PORT=9222
OPENCLAW_BROWSER_VNC_PORT=5900
OPENCLAW_BROWSER_NOVNC_PORT=6080
OPENCLAW_BROWSER_HEADLESS=0
OPENCLAW_BROWSER_ENABLE_NOVNC=1
```

## Config Examples

### Sandbox Browser (Recommended)

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

### Remote Browser

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

## Troubleshooting

```bash
# Check browser container
docker compose ps openclaw-browser

# View browser logs
docker compose logs openclaw-browser

# Restart browser
docker compose restart openclaw-browser

# Test CDP endpoint
curl http://localhost:9222/json/version
```

## Next Steps

See `DOCKER_BROWSER_SETUP.md` for detailed documentation.
