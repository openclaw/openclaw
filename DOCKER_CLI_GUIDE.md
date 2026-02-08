#!/bin/bash
# OpenClaw Docker CLI Documentation

## Global CLI Access

The `openclaw` command is now available globally from any directory.

### Usage

```bash
# From anywhere:
openclaw status
openclaw health
openclaw plugins list
openclaw dashboard
```

### Installation

The script has been copied to `/usr/local/bin/openclaw` and can be run from any terminal.

## Plugin Management

### Method 1: Using docker-compose run (RECOMMENDED)

This method has full permissions and network access:

```bash
# Install a plugin
docker compose -f /Users/manojmalviya/Documents/projects/openclaw/docker-compose.yml run --rm openclaw-cli plugins install @openclaw/msteams

# Remove a plugin  
docker compose -f /Users/manojmalviya/Documents/projects/openclaw/docker-compose.yml run --rm openclaw-cli plugins uninstall msteams

# List installed plugins
docker compose -f /Users/manojmalviya/Documents/projects/openclaw/docker-compose.yml run --rm openclaw-cli plugins list
```

### Method 2: Add to Dockerfile (For permanent plugins)

Edit `Dockerfile` and add before the final CMD:

```dockerfile
# Install plugins
RUN pnpm add @openclaw/msteams
```

Then rebuild:
```bash
docker compose build
docker compose up -d
```

### Method 3: Volume mount for development

Mount your local plugins directory:

```yaml
# In docker-compose.yml
volumes:
  - ./local-plugins:/home/node/.openclaw/extensions
```

## Common Commands

### Gateway Management
```bash
openclaw status           # Check gateway status
openclaw health           # Health check
openclaw dashboard        # Get dashboard URL
openclaw logs             # View logs
```

### Plugin Management
```bash
openclaw plugins list                  # List all plugins
openclaw plugins install @openclaw/X   # Install plugin (may fail due to permissions)
```

### Channel Management
```bash
openclaw channels login    # Login to channels
openclaw channels status   # Check channel status
```

### Configuration
```bash
openclaw configure         # Interactive configuration
openclaw config get X      # Get config value
openclaw config set X Y    # Set config value
```

## Troubleshooting

### "npm install failed" during plugin installation

This happens because `docker exec` doesn't have full permissions. Use Method 1 (docker compose run) instead:

```bash
docker compose -f /Users/manojmalviya/Documents/projects/openclaw/docker-compose.yml run --rm openclaw-cli plugins install @openclaw/msteams
```

### Plugin not loading after installation

Restart the gateway:
```bash
docker compose -f /Users/manojmalviya/Documents/projects/openclaw/docker-compose.yml restart openclaw-gateway
```
