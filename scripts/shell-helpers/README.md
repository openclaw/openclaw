# ClawDock <!-- omit in toc -->

Stop typing `docker-compose` commands. Just type `clawdock-start`.

Inspired by Simon Willison's [Running OpenClaw in Docker](https://til.simonwillison.net/llms/openclaw-docker).

- [Quickstart](#quickstart)
- [Available Commands](#available-commands)
- [Common Workflows](#common-workflows)
- [Troubleshooting](#troubleshooting)
- [Requirements](#requirements)
- [Contributing](#contributing)

## Quickstart

**Try it out:**

```bash
source <(curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh)
```

**Make it permanent:**

```bash
echo 'source <(curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh)' >> ~/.zshrc
```

**See what you get:**

```bash
clawdock-help
```

**First time setup:**

```bash
clawdock-start
```

```bash
clawdock-fix-token
```

```bash
clawdock-dashboard
```

If you see "pairing required":

```bash
clawdock-devices
```

```bash
clawdock-approve <request-id>
```

## Available Commands

### Basic Operations

| Command | Description |
|---------|-------------|
| `clawdock-start` | Start the gateway |
| `clawdock-stop` | Stop the gateway |
| `clawdock-restart` | Restart the gateway |
| `clawdock-status` | Check container status |
| `clawdock-logs` | View live logs (follows output) |

### Container Access

| Command | Description |
|---------|-------------|
| `clawdock-shell` | Interactive shell inside the gateway container |
| `clawdock-cli <command>` | Run OpenClaw CLI commands |
| `clawdock-exec <command>` | Execute arbitrary commands in the container |

### Web UI & Devices

| Command | Description |
|---------|-------------|
| `clawdock-dashboard` | Open web UI in browser with authentication |
| `clawdock-devices` | List device pairing requests |
| `clawdock-approve <id>` | Approve a device pairing request |

### Setup & Configuration

| Command | Description |
|---------|-------------|
| `clawdock-fix-token` | Configure gateway authentication token (run once) |

### Maintenance

| Command | Description |
|---------|-------------|
| `clawdock-rebuild` | Rebuild the Docker image |
| `clawdock-clean` | Remove all containers and volumes (destructive!) |

### Utilities

| Command | Description |
|---------|-------------|
| `clawdock-health` | Run gateway health check |
| `clawdock-token` | Display the gateway authentication token |
| `clawdock-cd` | Jump to the OpenClaw project directory |
| `clawdock-config` | Open the OpenClaw config directory |
| `clawdock-workspace` | Open the workspace directory |
| `clawdock-help` | Show all available commands with examples |

## Common Workflows

### Check Status and Logs

**Check container status:**

```bash
clawdock-status
```

**View live logs:**

```bash
clawdock-logs
```

### Restart After Configuration Changes

**Restart the gateway:**

```bash
clawdock-restart
```

**Watch the logs:**

```bash
clawdock-logs
```

### Set Up WhatsApp Bot

**Shell into the container:**

```bash
clawdock-shell
```

**Inside the container, login to WhatsApp:**

```bash
openclaw channels login --channel whatsapp --verbose
```

Scan the QR code with WhatsApp on your phone.

**Verify connection:**

```bash
openclaw status
```

### Troubleshooting Device Pairing

**Check for pending pairing requests:**

```bash
clawdock-devices
```

**Copy the Request ID from the "Pending" table, then approve:**

```bash
clawdock-approve 6f9db1bd-a1cc-4d3f-b643-2c195262464e
```

Then refresh your browser.

### Fix Token Mismatch Issues

If you see "gateway token mismatch" errors:

```bash
clawdock-fix-token
```

This will:
1. Read the token from your `.env` file
2. Configure it in the OpenClaw config
3. Restart the gateway
4. Verify the configuration

## Troubleshooting

### Commands Not Found

**Source the helpers file:**

```bash
source <(curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh)
```

Add this line to your `~/.zshrc` or `~/.bashrc` for persistence.

### Token Mismatch Errors

**Run the token fixer:**

```bash
clawdock-fix-token
```

### Permission Denied

**Ensure Docker is running and you have permission:**

```bash
docker ps
```

### Container Not Starting

**Check the logs:**

```bash
clawdock-logs
```

Common issues:
- Port 18789 or 18790 already in use
- Missing environment variables in `.env`
- Docker daemon not running

## Requirements

- Docker and Docker Compose installed
- Bash or Zsh shell
- OpenClaw project (from `docker-setup.sh`)

## Contributing

Found a bug or want to add a new helper? Contributions welcome!

1. Test your changes locally
2. Ensure helpers work in both bash and zsh
3. Follow the naming convention (`clawdock-*`)
4. Add documentation for new commands
5. Submit a pull request
