---
summary: "Automated, hardened OpenClaw host installation with Ansible, firewall isolation, and optional Tailscale VPN"
read_when:
  - You want automated server deployment with security hardening
  - You need firewall-isolated setup with VPN access
  - You're deploying to remote Debian/Ubuntu servers
title: "Ansible"
---

Deploy OpenClaw to production servers with **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**, an automated installer with a security-first architecture.

<Info>
The [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) repo is the source of truth for Ansible deployment. This page is a quick overview.
</Info>

## Prerequisites

| Requirement | Details                                                   |
| ----------- | --------------------------------------------------------- |
| OS          | Debian 11+ or Ubuntu 20.04+                               |
| Access      | Root or sudo privileges                                   |
| Network     | Internet connection for package installation              |
| Ansible     | 2.14+ (installed automatically by the quick-start script) |

## What you get

- Firewall-first security: UFW + Docker isolation (only SSH reachable, plus Tailscale when enabled)
- Optional Tailscale VPN for remote access without exposing services publicly
- Docker for isolated sandbox containers with localhost-only bindings
- A dedicated unprivileged `openclaw` user with scoped sudo, ready for `openclaw onboard --install-daemon`
- One-command setup

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

## What gets installed

1. Tailscale (mesh VPN), only when `tailscale_enabled=true`
2. UFW firewall (SSH only, plus Tailscale when enabled), fail2ban for SSH, and unattended security upgrades
3. Docker CE + Compose V2 (default agent sandbox backend)
4. Node.js from NodeSource (major version set by `nodejs_version`) and pnpm. OpenClaw accepts Node 24.16.0+ on 24.x or 26.1.0+; 24.22.1+/26.12.1+ is strongly recommended for security. Check `node --version` after the install.
5. OpenClaw, installed host-based with pnpm as the `openclaw` user, not containerized

The playbook does not create `openclaw.json` or a Gateway service. Onboarding does both: it installs the Gateway as the systemd **user** service `openclaw-gateway.service` of the `openclaw` user. The installer does not add systemd sandboxing directives (such as `NoNewPrivileges` or `PrivateTmp`) to that unit.

<Note>
The gateway runs directly on the host, not in Docker. Agent sandboxing is
optional; this playbook installs Docker because it is the default sandbox
backend. The `openclaw` user is not added to the root-equivalent `docker`
group, so giving the Gateway Docker access is an administrator decision. See
[Sandboxing](/gateway/sandboxing) for other backends.
</Note>

## Post-install setup

<Steps>
  <Step title="Switch to the openclaw user">
    ```bash
    sudo -i -u openclaw
    ```
  </Step>
  <Step title="Run onboarding and install the Gateway service">
    ```bash
    openclaw onboard --install-daemon
    ```
  </Step>
  <Step title="Connect messaging channels">
    Log in to WhatsApp, Telegram, Discord, or Signal:
    ```bash
    openclaw channels login --channel <name>
    ```
  </Step>
  <Step title="Verify the installation">
    ```bash
    openclaw gateway status
    openclaw security audit
    ```
  </Step>
  <Step title="Connect to Tailscale (optional)">
    If you installed with `tailscale_enabled=true`, join your VPN mesh for secure remote access.
  </Step>
</Steps>

### Quick commands

Run these as the `openclaw` user (`sudo -i -u openclaw`):

```bash
# Check service status
openclaw gateway status
systemctl --user status openclaw-gateway.service

# View live logs
openclaw logs --follow

# Restart gateway
openclaw gateway restart

# Channel login
openclaw channels login --channel <name>
```

`openclaw gateway restart` records managed restart intent. For a system-scope service, follow the exact `sudo systemctl restart <unit>` command it prints.

## Security architecture

Four-layer defense model:

1. Firewall (UFW): only SSH (22) exposed publicly, plus Tailscale (41641/udp) when enabled
2. Loopback Gateway: the installer does not change OpenClaw's default loopback bind; reach it through an SSH tunnel or [Tailscale Serve](/gateway/tailscale)
3. Docker isolation: `DOCKER-USER` iptables chain prevents external port exposure
4. Unprivileged user: the Gateway runs as `openclaw` with scoped sudo and without membership in the root-equivalent `docker` group

The installer does not harden the Gateway's systemd unit. Inspect it as the `openclaw` user with `systemctl --user show openclaw-gateway.service -p NoNewPrivileges -p PrivateTmp -p ProtectSystem`.

Check which ports are publicly reachable:

```bash
nmap -p- YOUR_SERVER_IP
```

Only port 22 (SSH) should be open. Gateway and Docker stay locked down.

Docker is installed for agent sandboxes (isolated tool execution), not for running the gateway. See [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools) for sandbox configuration.

## Manual installation

<Steps>
  <Step title="Install prerequisites">
    ```bash
    sudo apt update && sudo apt install -y ansible git
    ```
  </Step>
  <Step title="Clone the repository">
    ```bash
    git clone https://github.com/openclaw/openclaw-ansible.git
    cd openclaw-ansible
    ```
  </Step>
  <Step title="Install Ansible collections">
    ```bash
    ansible-galaxy collection install -r requirements.yml
    ```
  </Step>
  <Step title="Run the playbook">
    ```bash
    ./run-playbook.sh
    ```

    Or run the playbook directly, then continue with [Post-install setup](#post-install-setup):
    ```bash
    ansible-playbook playbook.yml --ask-become-pass
    ```

  </Step>
</Steps>

## Updating

The Ansible installer sets up OpenClaw for manual updates; see [Updating](/install/updating) for the standard flow.

To re-run the playbook (for example, after configuration changes):

```bash
cd openclaw-ansible
./run-playbook.sh
```

You can run this multiple times without duplicating its effects.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Firewall blocks my connection">
    - SSH (port 22) is always allowed. The Gateway listens on loopback; use an SSH tunnel or [Tailscale Serve](/gateway/tailscale).

  </Accordion>
  <Accordion title="Service will not start">
    Run these as the `openclaw` user (`sudo -i -u openclaw`):
    ```bash
    # Check service state and logs
    openclaw gateway status
    systemctl --user status openclaw-gateway.service
    openclaw logs

    # Verify permissions
    ls -la ~/.openclaw ~/.config/systemd/user

    # Test manual start
    openclaw gateway run
    ```

  </Accordion>
  <Accordion title="Docker sandbox issues">
    Run these from your administrator account, not as `openclaw`: the
    `openclaw` user has neither Docker access nor general sudo rights.
    ```bash
    # Verify Docker is running
    sudo systemctl status docker

    # Check sandbox image
    sudo docker images | grep openclaw-sandbox
    ```

    If the image is missing, build it from a source checkout that your administrator account owns, not from a checkout the `openclaw` user can write to. See [Images and setup](/gateway/sandboxing/images-and-setup).

  </Accordion>
  <Accordion title="Channel login fails">
    Make sure you are running as the `openclaw` user:
    ```bash
    sudo -i -u openclaw
    openclaw channels login --channel <name>
    ```
  </Accordion>
</AccordionGroup>

## Advanced configuration

For detailed security architecture and troubleshooting, see the openclaw-ansible repo:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Related

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible): full deployment guide
- [Docker](/install/docker): containerized gateway setup
- [Sandboxing](/gateway/sandboxing): agent sandbox configuration
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools): per-agent isolation
