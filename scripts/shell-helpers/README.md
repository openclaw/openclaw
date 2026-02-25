# ClawDock <!-- omit in toc -->

Stop typing `docker-compose` commands. Just type `activiock-start`.

Inspired by Simon Willison's [Running Activi in Docker](https://til.simonwillison.net/llms/activi-docker).

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
mkdir -p ~/.activiock && curl -sL https://raw.githubusercontent.com/activi/activi/main/scripts/shell-helpers/activiock-helpers.sh -o ~/.activiock/activiock-helpers.sh
```

```bash
echo 'source ~/.activiock/activiock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

**See what you get:**

```bash
activiock-help
```

On first command, ClawDock auto-detects your Activi directory:

- Checks common paths (`~/activi`, `~/workspace/activi`, etc.)
- If found, asks you to confirm
- Saves to `~/.activiock/config`

**First time setup:**

```bash
activiock-start
```

```bash
activiock-fix-token
```

```bash
activiock-dashboard
```

If you see "pairing required":

```bash
activiock-devices
```

And approve the request for the specific device:

```bash
activiock-approve <request-id>
```

## Available Commands

### Basic Operations

| Command            | Description                     |
| ------------------ | ------------------------------- |
| `activiock-start`   | Start the gateway               |
| `activiock-stop`    | Stop the gateway                |
| `activiock-restart` | Restart the gateway             |
| `activiock-status`  | Check container status          |
| `activiock-logs`    | View live logs (follows output) |

### Container Access

| Command                   | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `activiock-shell`          | Interactive shell inside the gateway container |
| `activiock-cli <command>`  | Run Activi CLI commands                      |
| `activiock-exec <command>` | Execute arbitrary commands in the container    |

### Web UI & Devices

| Command                 | Description                                |
| ----------------------- | ------------------------------------------ |
| `activiock-dashboard`    | Open web UI in browser with authentication |
| `activiock-devices`      | List device pairing requests               |
| `activiock-approve <id>` | Approve a device pairing request           |

### Setup & Configuration

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `activiock-fix-token` | Configure gateway authentication token (run once) |

### Maintenance

| Command            | Description                                      |
| ------------------ | ------------------------------------------------ |
| `activiock-rebuild` | Rebuild the Docker image                         |
| `activiock-clean`   | Remove all containers and volumes (destructive!) |

### Utilities

| Command              | Description                               |
| -------------------- | ----------------------------------------- |
| `activiock-health`    | Run gateway health check                  |
| `activiock-token`     | Display the gateway authentication token  |
| `activiock-cd`        | Jump to the Activi project directory    |
| `activiock-config`    | Open the Activi config directory        |
| `activiock-workspace` | Open the workspace directory              |
| `activiock-help`      | Show all available commands with examples |

## Common Workflows

### Check Status and Logs

**Restart the gateway:**

```bash
activiock-restart
```

**Check container status:**

```bash
activiock-status
```

**View live logs:**

```bash
activiock-logs
```

### Set Up WhatsApp Bot

**Shell into the container:**

```bash
activiock-shell
```

**Inside the container, login to WhatsApp:**

```bash
activi channels login --channel whatsapp --verbose
```

Scan the QR code with WhatsApp on your phone.

**Verify connection:**

```bash
activi status
```

### Troubleshooting Device Pairing

**Check for pending pairing requests:**

```bash
activiock-devices
```

**Copy the Request ID from the "Pending" table, then approve:**

```bash
activiock-approve <request-id>
```

Then refresh your browser.

### Fix Token Mismatch Issues

If you see "gateway token mismatch" errors:

```bash
activiock-fix-token
```

This will:

1. Read the token from your `.env` file
2. Configure it in the Activi config
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
- Activi project (from `docker-setup.sh`)

## Development

**Test with fresh config (mimics first-time install):**

```bash
unset CLAWDOCK_DIR && rm -f ~/.activiock/config && source scripts/shell-helpers/activiock-helpers.sh
```

Then run any command to trigger auto-detect:

```bash
activiock-start
```
