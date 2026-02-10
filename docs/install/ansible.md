---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Automated, hardened OpenClaw installation with Ansible, Tailscale VPN, and firewall isolation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want automated server deployment with security hardening（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need firewall-isolated setup with VPN access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You're deploying to remote Debian/Ubuntu servers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Ansible"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Ansible Installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The recommended way to deploy OpenClaw to production servers is via **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — an automated installer with security-first architecture.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One-command install:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **📦 Full guide: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> The openclaw-ansible repo is the source of truth for Ansible deployment. This page is a quick overview.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What You Get（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🔒 **Firewall-first security**: UFW + Docker isolation (only SSH + Tailscale accessible)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🔐 **Tailscale VPN**: Secure remote access without exposing services publicly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🐳 **Docker**: Isolated sandbox containers, localhost-only bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🛡️ **Defense in depth**: 4-layer security architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🚀 **One-command setup**: Complete deployment in minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 🔧 **Systemd integration**: Auto-start on boot with hardening（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **OS**: Debian 11+ or Ubuntu 20.04+（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Access**: Root or sudo privileges（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Network**: Internet connection for package installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Ansible**: 2.14+ (installed automatically by quick-start script)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What Gets Installed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Ansible playbook installs and configures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Tailscale** (mesh VPN for secure remote access)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **UFW firewall** (SSH + Tailscale ports only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Docker CE + Compose V2** (for agent sandboxes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Node.js 22.x + pnpm** (runtime dependencies)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **OpenClaw** (host-based, not containerized)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Systemd service** (auto-start with security hardening)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: The gateway runs **directly on the host** (not in Docker), but agent sandboxes use Docker for isolation. See [Sandboxing](/gateway/sandboxing) for details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Post-Install Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After installation completes, switch to the openclaw user:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo -i -u openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The post-install script will guide you through:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Onboarding wizard**: Configure OpenClaw settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Provider login**: Connect WhatsApp/Telegram/Discord/Signal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Gateway testing**: Verify the installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Tailscale setup**: Connect to your VPN mesh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Quick commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check service status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl status openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# View live logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo journalctl -u openclaw -f（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Restart gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl restart openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Provider login (run as openclaw user)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo -i -u openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security Architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4-Layer Defense（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Firewall (UFW)**: Only SSH (22) + Tailscale (41641/udp) exposed publicly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **VPN (Tailscale)**: Gateway accessible only via VPN mesh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Docker Isolation**: DOCKER-USER iptables chain prevents external port exposure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Systemd Hardening**: NoNewPrivileges, PrivateTmp, unprivileged user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Verification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Test external attack surface:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
nmap -p- YOUR_SERVER_IP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Should show **only port 22** (SSH) open. All other services (gateway, Docker) are locked down.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Docker Availability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docker is installed for **agent sandboxes** (isolated tool execution), not for running the gateway itself. The gateway binds to localhost only and is accessible via Tailscale VPN.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for sandbox configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Manual Installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you prefer manual control over the automation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 1. Install prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt update && sudo apt install -y ansible git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 2. Clone repository（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
git clone https://github.com/openclaw/openclaw-ansible.git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw-ansible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 3. Install Ansible collections（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ansible-galaxy collection install -r requirements.yml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 4. Run playbook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./run-playbook.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or run directly (then manually execute /tmp/openclaw-setup.sh after)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ansible-playbook playbook.yml --ask-become-pass（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Updating OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Ansible installer sets up OpenClaw for manual updates. See [Updating](/install/updating) for the standard update flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To re-run the Ansible playbook (e.g., for configuration changes):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd openclaw-ansible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./run-playbook.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: This is idempotent and safe to run multiple times.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Firewall blocks my connection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you're locked out:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure you can access via Tailscale VPN first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH access (port 22) is always allowed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway is **only** accessible via Tailscale by design（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Service won't start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo journalctl -u openclaw -n 100（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo ls -la /opt/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Test manual start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo -i -u openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Docker sandbox issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify Docker is running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl status docker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check sandbox image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo docker images | grep openclaw-sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Build sandbox image if missing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd /opt/openclaw/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo -u openclaw ./scripts/sandbox-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Provider login fails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Make sure you're running as the `openclaw` user:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo -i -u openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Advanced Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For detailed security architecture and troubleshooting:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — full deployment guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Docker](/install/docker) — containerized gateway setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Sandboxing](/gateway/sandboxing) — agent sandbox configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — per-agent isolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
