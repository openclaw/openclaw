---
summary: "Run OpenClaw on a self-managed Hostinger VPS"
read_when:
  - Setting up OpenClaw on a Hostinger VPS
  - You want a VPS install that you administer yourself
title: "Hostinger VPS"
doc-schema-version: 1
---

Run a persistent OpenClaw Gateway on a Hostinger VPS the same way you would on
any Linux server you control. This guide covers the self-managed path: you own
the operating system, SSH access, OpenClaw configuration, backups, and updates.

<Note>
OpenClaw docs do not list or recommend third-party turnkey service offerings.
Use this guide for a VPS where you administer the server yourself.
</Note>

## Prerequisites

- Hostinger VPS running Ubuntu 24.04 LTS or another supported Linux image
- SSH access to the VPS
- A non-root user with `sudo`
- Model provider credentials or an auth flow you plan to configure during onboarding
- Optional: Tailscale or DNS if you want access without an SSH tunnel

Use a clean base image. If a provider marketplace image or panel automation is
available, review its startup scripts, firewall defaults, and update behavior
before using it.

## Create and secure the VPS

Create a Linux VPS and connect over SSH:

```bash
ssh user@gateway-host
```

Update the package index and install the basic tools OpenClaw setup commonly
needs:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq
```

Before exposing any service, decide how you will administer the host:

- Keep SSH restricted to trusted keys and trusted source networks where possible.
- Prefer loopback Gateway access through an SSH tunnel or Tailscale.
- If you later bind the Gateway to `lan` or `tailnet`, require
  `gateway.auth.token` or `gateway.auth.password`.

## Install OpenClaw

Run the installer script on the VPS:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Then run onboarding and install the Gateway as a user service:

```bash
openclaw onboard --install-daemon
```

Follow the prompts for model auth, Gateway auth, and any channels you want to
connect.

## Access the dashboard

For a loopback Gateway, forward the dashboard port to your local machine:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
```

Open the local dashboard URL from the onboarding output, for example:

```text
http://127.0.0.1:18789/#token=<your-token>
```

If you use Tailscale, see [Tailscale](/gateway/tailscale) for the Gateway
access options.

## Operations

Back up state and workspace data before changing plans, rebuilding the VPS, or
moving to another host:

```bash
openclaw backup create
```

For updates and service restart behavior, see [Updating OpenClaw](/install/updating).

## Troubleshooting

**Dashboard not loading** -- Verify the Gateway service is running and that your
SSH tunnel points to the same port shown by onboarding:

```bash
openclaw gateway status --deep
```

**Service fails after reboot** -- Check the user service logs and confirm Node is
available in the service environment:

```bash
journalctl --user -u openclaw-gateway.service --no-pager -n 100
```

**Small VPS feels slow** -- Use the Linux server tuning notes in
[Linux server](/vps#startup-tuning-for-small-vms-and-arm-hosts).

## Related

- [Linux server](/vps)
- [Gateway remote access](/gateway/remote)
- [Gateway security](/gateway/security)
- [DigitalOcean](/install/digitalocean)
