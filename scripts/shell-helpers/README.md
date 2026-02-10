# ClawDock <!-- omit in toc -->（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stop typing `docker-compose` commands. Just type `clawdock-start`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inspired by Simon Willison's [Running OpenClaw in Docker](https://til.simonwillison.net/llms/openclaw-docker).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Quickstart](#quickstart)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Available Commands](#available-commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Basic Operations](#basic-operations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Container Access](#container-access)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Web UI \& Devices](#web-ui--devices)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Setup \& Configuration](#setup--configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Maintenance](#maintenance)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Utilities](#utilities)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Common Workflows](#common-workflows)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Check Status and Logs](#check-status-and-logs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Set Up WhatsApp Bot](#set-up-whatsapp-bot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Troubleshooting Device Pairing](#troubleshooting-device-pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Fix Token Mismatch Issues](#fix-token-mismatch-issues)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - [Permission Denied](#permission-denied)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Requirements](#requirements)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quickstart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Install:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**See what you get:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-help（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On first command, ClawDock auto-detects your OpenClaw directory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Checks common paths (`~/openclaw`, `~/workspace/openclaw`, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If found, asks you to confirm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Saves to `~/.clawdock/config`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**First time setup:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-fix-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-dashboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you see "pairing required":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
And approve the request for the specific device:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-approve <request-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Available Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Basic Operations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command            | Description                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------ | ------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-start`   | Start the gateway               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-stop`    | Stop the gateway                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-restart` | Restart the gateway             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-status`  | Check container status          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-logs`    | View live logs (follows output) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Container Access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command                   | Description                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------- | ---------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-shell`          | Interactive shell inside the gateway container |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-cli <command>`  | Run OpenClaw CLI commands                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-exec <command>` | Execute arbitrary commands in the container    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Web UI & Devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command                 | Description                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | ------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-dashboard`    | Open web UI in browser with authentication |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-devices`      | List device pairing requests               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-approve <id>` | Approve a device pairing request           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Setup & Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command              | Description                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------- | ------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-fix-token` | Configure gateway authentication token (run once) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Maintenance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command            | Description                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------ | ------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-rebuild` | Rebuild the Docker image                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-clean`   | Remove all containers and volumes (destructive!) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Utilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command              | Description                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------- | ----------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-health`    | Run gateway health check                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-token`     | Display the gateway authentication token  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-cd`        | Jump to the OpenClaw project directory    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-config`    | Open the OpenClaw config directory        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-workspace` | Open the workspace directory              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `clawdock-help`      | Show all available commands with examples |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common Workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Check Status and Logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Restart the gateway:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Check container status:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**View live logs:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Set Up WhatsApp Bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Shell into the container:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-shell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Inside the container, login to WhatsApp:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login --channel whatsapp --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scan the QR code with WhatsApp on your phone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Verify connection:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Troubleshooting Device Pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Check for pending pairing requests:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Copy the Request ID from the "Pending" table, then approve:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-approve <request-id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then refresh your browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fix Token Mismatch Issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you see "gateway token mismatch" errors:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-fix-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This will:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Read the token from your `.env` file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Configure it in the OpenClaw config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Restart the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Verify the configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Permission Denied（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Ensure Docker is running and you have permission:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker ps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker and Docker Compose installed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bash or Zsh shell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw project (from `docker-setup.sh`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Development（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Test with fresh config (mimics first-time install):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
unset CLAWDOCK_DIR && rm -f ~/.clawdock/config && source scripts/shell-helpers/clawdock-helpers.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then run any command to trigger auto-detect:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
clawdock-start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
