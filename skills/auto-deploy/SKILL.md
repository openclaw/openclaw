# Auto-Deployment Skill

Automatically deploy OpenClaw on Linux servers with minimal manual intervention.

## Description

This skill guides users through deploying OpenClaw on various Linux distributions (OpenCloudOS/RHEL/CentOS/Ubuntu) by:
- Detecting the operating system and environment
- Checking prerequisites (Node.js 22+, disk space, RAM)
- Installing missing dependencies automatically
- Running interactive configuration wizard (gateway, model provider, API keys)
- Setting up systemd service
- Providing troubleshooting and diagnostics

## Use Cases

- Fresh server deployment
- Reinstalling OpenClaw after failures
- Quick setup for testing environments
- Automated installation with minimal user input

## Features

- **OS Detection**: Supports OpenCloudOS, RHEL, CentOS, Ubuntu
- **Prerequisites Check**: Node.js 22+, disk space, RAM, network
- **Auto-Installation**: Installs Node.js if missing
- **Configuration Wizard**: Interactive prompts for gateway, model, API keys
- **Service Management**: Automatic systemd service setup
- **Verification**: Post-install validation checks
- **Troubleshooting**: Detects and fixes common issues (10+ documented)

## How It Works

### Phase 1: Pre-Flight Checks
- Detect OS and version
- Check Node.js version
- Verify disk space and RAM
- Test network connectivity

### Phase 2: Automated Installation
- Install Node.js 22 if missing
- Run OpenClaw installer script
- Fix directory permissions
- Configure systemd service

### Phase 3: Interactive Configuration
- Gateway mode selection (local/remote)
- Auth token generation
- Model provider selection (Zhipu AI, OpenAI, etc.)
- API key collection and validation
- Configuration file generation

### Phase 4: Service Management
- Start Gateway service
- Enable auto-start on boot
- Verify service status

### Phase 5: Post-Install Setup
- Generate SSH tunnel command
- Create dashboard URL with token
- Test dashboard connectivity

### Phase 6: Verification & Troubleshooting
- Run comprehensive verification checklist
- Detect and fix common issues
- Provide helpful error messages

## Requirements

- Linux server (OpenCloudOS/RHEL/CentOS/Ubuntu)
- SSH access with root or sudo privileges
- Internet connectivity for downloading dependencies

## Installation

This skill is installed as part of OpenClaw. No additional setup required.

## Usage

Start the auto-deployment wizard:

```bash
# Interactive mode
openclaw skill auto-deploy

# Or within OpenClaw chat
/run auto-deploy
```

## Examples

### Example 1: Fresh Ubuntu Server

```bash
User: Help me install OpenClaw on my server
Skill: Running pre-flight checks...
Skill: Detected Ubuntu 22.04. Node.js is not installed.
Skill: Should I install Node.js 22? (y/n)
User: y
Skill: Installing Node.js...
Skill: OpenClaw installed. Configuring...
Skill: Which model provider? (1) Zhipu AI (2) OpenAI
User: 1
Skill: Enter your Zhipu API Key:
User: [pastes key]
Skill: ✓ Installation complete!
       Dashboard: http://localhost:8888?token=...
```

### Example 2: RHEL with Node.js Already Installed

```bash
User: Install OpenClaw
Skill: Detected RHEL 9. Node.js v22.10.0 found ✓
Skill: Running installer...
Skill: Configuring gateway...
Skill: ✓ OpenClaw ready!
```

## Troubleshooting

### Node.js Installation Fails

Ensure EPEL repository is enabled on RHEL/CentOS:
```bash
dnf install -y epel-release
```

### Permission Errors

Fix OpenClaw directory permissions:
```bash
chmod -R 700 ~/.openclaw
```

### Service Won't Start

Check logs:
```bash
journalctl -u openclaw-gateway -f
```

## Related Documentation

- Complete Installation Guide: `docs/installation-guide.md`
- Docker Deployment: https://til.simonwillison.net/llms/openclaw-docker
- GitHub Issue: https://github.com/alijiujiu123/openclaw/issues/1

## Version

1.0.0 - Initial release supporting OpenCloudOS, RHEL, CentOS, Ubuntu
