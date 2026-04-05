---
summary: "Run Mullusi Gateway 24/7 on a cheap Hetzner VPS (Docker) with durable state and baked-in binaries"
read_when:
  - You want Mullusi running 24/7 on a cloud VPS (not your laptop)
  - You want a production-grade, always-on Gateway on your own VPS
  - You want full control over persistence, binaries, and restart behavior
  - You are running Mullusi in Docker on Hetzner or a similar provider
title: "Hetzner"
---

# Mullusi on Hetzner (Docker, Production VPS Guide)

## Goal

Run a persistent Mullusi Gateway on a Hetzner VPS using Docker, with durable state, baked-in binaries, and safe restart behavior.

If you want “Mullusi 24/7 for ~$5”, this is the simplest reliable setup.
Hetzner pricing changes; pick the smallest Debian/Ubuntu VPS and scale up if you hit OOMs.

Security model reminder:

- Company-shared agents are fine when everyone is in the same trust boundary and the runtime is business-only.
- Keep strict separation: dedicated VPS/runtime + dedicated accounts; no personal Apple/Google/browser/password-manager profiles on that host.
- If users are adversarial to each other, split by gateway/host/OS user.

See [Security](/gateway/security) and [VPS hosting](/vps).

## What are we doing (simple terms)?

- Rent a small Linux server (Hetzner VPS)
- Install Docker (isolated app runtime)
- Start the Mullusi Gateway in Docker
- Persist `~/.mullusi` + `~/.mullusi/workspace` on the host (survives restarts/rebuilds)
- Access the Control UI from your laptop via an SSH tunnel

That mounted `~/.mullusi` state includes `mullusi.json`, per-agent
`agents/<agentId>/agent/auth-profiles.json`, and `.env`.

The Gateway can be accessed via:

- SSH port forwarding from your laptop
- Direct port exposure if you manage firewalling and tokens yourself

This guide assumes Ubuntu or Debian on Hetzner.  
If you are on another Linux VPS, map packages accordingly.
For the generic Docker flow, see [Docker](/install/docker).

---

## Quick path (experienced operators)

1. Provision Hetzner VPS
2. Install Docker
3. Clone Mullusi repository
4. Create persistent host directories
5. Configure `.env` and `docker-compose.yml`
6. Bake required binaries into the image
7. `docker compose up -d`
8. Verify persistence and Gateway access

---

## What you need

- Hetzner VPS with root access
- SSH access from your laptop
- Basic comfort with SSH + copy/paste
- ~20 minutes
- Docker and Docker Compose
- Model auth credentials
- Optional provider credentials
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

<Steps>
  <Step title="Provision the VPS">
    Create an Ubuntu or Debian VPS in Hetzner.

    Connect as root:

    ```bash
    ssh root@YOUR_VPS_IP
    ```

    This guide assumes the VPS is stateful.
    Do not treat it as disposable infrastructure.

  </Step>

  <Step title="Install Docker (on the VPS)">
    ```bash
    apt-get update
    apt-get install -y git curl ca-certificates
    curl -fsSL https://get.docker.com | sh
    ```

    Verify:

    ```bash
    docker --version
    docker compose version
    ```

  </Step>

  <Step title="Clone the Mullusi repository">
    ```bash
    git clone https://github.com/mullusi/mullusi.git
    cd mullusi
    ```

    This guide assumes you will build a custom image to guarantee binary persistence.

  </Step>

  <Step title="Create persistent host directories">
    Docker containers are ephemeral.
    All long-lived state must live on the host.

    ```bash
    mkdir -p /root/.mullusi/workspace

    # Set ownership to the container user (uid 1000):
    chown -R 1000:1000 /root/.mullusi
    ```

  </Step>

  <Step title="Configure environment variables">
    Create `.env` in the repository root.

    ```bash
    MULLUSI_IMAGE=mullusi:latest
    MULLUSI_GATEWAY_TOKEN=change-me-now
    MULLUSI_GATEWAY_BIND=lan
    MULLUSI_GATEWAY_PORT=18790

    MULLUSI_CONFIG_DIR=/root/.mullusi
    MULLUSI_WORKSPACE_DIR=/root/.mullusi/workspace

    GOG_KEYRING_PASSWORD=change-me-now
    XDG_CONFIG_HOME=/home/node/.mullusi
    ```

    Generate strong secrets:

    ```bash
    openssl rand -hex 32
    ```

    **Do not commit this file.**

    This `.env` file is for container/runtime env such as `MULLUSI_GATEWAY_TOKEN`.
    Stored provider OAuth/API-key auth lives in the mounted
    `~/.mullusi/agents/<agentId>/agent/auth-profiles.json`.

  </Step>

  <Step title="Docker Compose configuration">
    Create or update `docker-compose.yml`.

    ```yaml
    services:
      mullusi-gateway:
        image: ${MULLUSI_IMAGE}
        build: .
        restart: unless-stopped
        env_file:
          - .env
        environment:
          - HOME=/home/node
          - NODE_ENV=production
          - TERM=xterm-256color
          - MULLUSI_GATEWAY_BIND=${MULLUSI_GATEWAY_BIND}
          - MULLUSI_GATEWAY_PORT=${MULLUSI_GATEWAY_PORT}
          - MULLUSI_GATEWAY_TOKEN=${MULLUSI_GATEWAY_TOKEN}
          - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
          - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
          - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
        volumes:
          - ${MULLUSI_CONFIG_DIR}:/home/node/.mullusi
          - ${MULLUSI_WORKSPACE_DIR}:/home/node/.mullusi/workspace
        ports:
          # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
          # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
          - "127.0.0.1:${MULLUSI_GATEWAY_PORT}:18790"
        command:
          [
            "node",
            "dist/index.js",
            "gateway",
            "--bind",
            "${MULLUSI_GATEWAY_BIND}",
            "--port",
            "${MULLUSI_GATEWAY_PORT}",
            "--allow-unconfigured",
          ]
    ```

    `--allow-unconfigured` is only for bootstrap convenience, it is not a replacement for a proper gateway configuration. Still set auth (`gateway.auth.token` or password) and use safe bind settings for your deployment.

  </Step>

  <Step title="Shared Docker VM runtime steps">
    Use the shared runtime guide for the common Docker host flow:

    - [Bake required binaries into the image](/install/docker-vm-runtime#bake-required-binaries-into-the-image)
    - [Build and launch](/install/docker-vm-runtime#build-and-launch)
    - [What persists where](/install/docker-vm-runtime#what-persists-where)
    - [Updates](/install/docker-vm-runtime#updates)

  </Step>

  <Step title="Hetzner-specific access">
    After the shared build and launch steps, tunnel from your laptop:

    ```bash
    ssh -N -L 18790:127.0.0.1:18790 root@YOUR_VPS_IP
    ```

    Open:

    `http://127.0.0.1:18790/`

    Paste the configured shared secret. This guide uses the gateway token by
    default; if you switched to password auth, use that password instead.

  </Step>
</Steps>

The shared persistence map lives in [Docker VM Runtime](/install/docker-vm-runtime#what-persists-where).

## Infrastructure as Code (Terraform)

For teams preferring infrastructure-as-code workflows, a community-maintained Terraform setup provides:

- Modular Terraform configuration with remote state management
- Automated provisioning via cloud-init
- Deployment scripts (bootstrap, deploy, backup/restore)
- Security hardening (firewall, UFW, SSH-only access)
- SSH tunnel configuration for gateway access

**Repositories:**

- Infrastructure: [mullusi-terraform-hetzner](https://github.com/andreesg/mullusi-terraform-hetzner)
- Docker config: [mullusi-docker-config](https://github.com/andreesg/mullusi-docker-config)

This approach complements the Docker setup above with reproducible deployments, version-controlled infrastructure, and automated disaster recovery.

> **Note:** Community-maintained. For issues or contributions, see the repository links above.

## Next steps

- Set up messaging channels: [Channels](/channels)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- Keep Mullusi up to date: [Updating](/install/updating)
