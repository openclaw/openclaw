# NeoDock <!-- omit in toc -->

Stop typing `docker-compose` commands. Just type `neodock-start`.

Inspired by Simon Willison's [Running SmartAgentNeo in Docker](https://til.simonwillison.net/llms/smart-agent-neo-docker).

- [Quickstart](#quickstart)
- [Available Commands](#available-commands)
  - [Basic Operations](#basic-operations)
  - [Container Access](#container-access)
  - [Web UI \& Devices](#web-ui--devices)
  - [Setup \& Configuration](#setup--configuration)
  - [Maintenance](#maintenance)
  - [Utilities](#utilities)
- [Common Workflows](#common-workflows)
  - [Check Status and Logs](#check-status-and-logs)
  - [Set Up WhatsApp Bot](#set-up-whatsapp-bot)
  - [Troubleshooting Device Pairing](#troubleshooting-device-pairing)
  - [Fix Token Mismatch Issues](#fix-token-mismatch-issues)
  - [Permission Denied](#permission-denied)
- [Requirements](#requirements)

## Quickstart

**Install:**

```bash
mkdir -p ~/.neodock && curl -sL https://raw.githubusercontent.com/betterbrand/smart-agent-neo/main/scripts/shell-helpers/neodock-helpers.sh -o ~/.neodock/neodock-helpers.sh
```

```bash
echo 'source ~/.neodock/neodock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

**See what you get:**

```bash
neodock-help
```

On first command, NeoDock auto-detects your SmartAgentNeo directory:

- Checks common paths (`~/smart-agent-neo`, `~/workspace/smart-agent-neo`, etc.)
- If found, asks you to confirm
- Saves to `~/.neodock/config`

**First time setup:**

```bash
neodock-start
```

```bash
neodock-fix-token
```

```bash
neodock-dashboard
```

If you see "pairing required":

```bash
neodock-devices
```

And approve the request for the specific device:

```bash
neodock-approve <request-id>
```

## Available Commands

### Basic Operations

| Command            | Description                     |
| ------------------ | ------------------------------- |
| `neodock-start`   | Start the gateway               |
| `neodock-stop`    | Stop the gateway                |
| `neodock-restart` | Restart the gateway             |
| `neodock-status`  | Check container status          |
| `neodock-logs`    | View live logs (follows output) |

### Container Access

| Command                   | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `neodock-shell`          | Interactive shell inside the gateway container |
| `neodock-cli <command>`  | Run SmartAgentNeo CLI commands                      |
| `neodock-exec <command>` | Execute arbitrary commands in the container    |

### Web UI & Devices

| Command                 | Description                                |
| ----------------------- | ------------------------------------------ |
| `neodock-dashboard`    | Open web UI in browser with authentication |
| `neodock-devices`      | List device pairing requests               |
| `neodock-approve <id>` | Approve a device pairing request           |

### Setup & Configuration

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `neodock-fix-token` | Configure gateway authentication token (run once) |

### Maintenance

| Command            | Description                                      |
| ------------------ | ------------------------------------------------ |
| `neodock-rebuild` | Rebuild the Docker image                         |
| `neodock-clean`   | Remove all containers and volumes (destructive!) |

### Utilities

| Command              | Description                               |
| -------------------- | ----------------------------------------- |
| `neodock-health`    | Run gateway health check                  |
| `neodock-token`     | Display the gateway authentication token  |
| `neodock-cd`        | Jump to the SmartAgentNeo project directory    |
| `neodock-config`    | Open the SmartAgentNeo config directory        |
| `neodock-workspace` | Open the workspace directory              |
| `neodock-help`      | Show all available commands with examples |

## Common Workflows

### Check Status and Logs

**Restart the gateway:**

```bash
neodock-restart
```

**Check container status:**

```bash
neodock-status
```

**View live logs:**

```bash
neodock-logs
```

### Set Up WhatsApp Bot

**Shell into the container:**

```bash
neodock-shell
```

**Inside the container, login to WhatsApp:**

```bash
smart-agent-neo channels login --channel whatsapp --verbose
```

Scan the QR code with WhatsApp on your phone.

**Verify connection:**

```bash
smart-agent-neo status
```

### Troubleshooting Device Pairing

**Check for pending pairing requests:**

```bash
neodock-devices
```

**Copy the Request ID from the "Pending" table, then approve:**

```bash
neodock-approve <request-id>
```

Then refresh your browser.

### Fix Token Mismatch Issues

If you see "gateway token mismatch" errors:

```bash
neodock-fix-token
```

This will:

1. Read the token from your `.env` file
2. Configure it in the SmartAgentNeo config
3. Restart the gateway
4. Verify the configuration

### Permission Denied

**Ensure Docker is running and you have permission:**

```bash
docker ps
```

## Requirements

- Docker and Docker Compose installed
- Bash or Zsh shell
- SmartAgentNeo project (from `docker-setup.sh`)

## Development

**Test with fresh config (mimics first-time install):**

```bash
unset NEODOCK_DIR && rm -f ~/.neodock/config && source scripts/shell-helpers/neodock-helpers.sh
```

Then run any command to trigger auto-detect:

```bash
neodock-start
```
