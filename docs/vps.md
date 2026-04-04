---
summary: "Run OpenClaw on a Linux server or cloud VPS — provider picker, architecture, and tuning"
read_when:
  - You want to run the Gateway on a Linux server or cloud VPS
  - You need a quick map of hosting guides
  - You want generic Linux server tuning for OpenClaw
title: "Linux Server"
sidebarTitle: "Linux Server"
---

# Linux Server

Run the OpenClaw Gateway on any Linux server or cloud VPS. This page helps you
pick a provider, explains how cloud deployments work, and covers generic Linux
tuning that applies everywhere.

## Pick a provider

<CardGroup cols={2}>
  <Card title="Railway" href="/install/railway">One-click, browser setup</Card>
  <Card title="Northflank" href="/install/northflank">One-click, browser setup</Card>
  <Card title="DigitalOcean" href="/install/digitalocean">Simple paid VPS</Card>
  <Card title="Oracle Cloud" href="/install/oracle">Always Free ARM tier</Card>
  <Card title="Fly.io" href="/install/fly">Fly Machines</Card>
  <Card title="Hetzner" href="/install/hetzner">Docker on Hetzner VPS</Card>
  <Card title="GCP" href="/install/gcp">Compute Engine</Card>
  <Card title="Azure" href="/install/azure">Linux VM</Card>
  <Card title="exe.dev" href="/install/exe-dev">VM with HTTPS proxy</Card>
  <Card title="Raspberry Pi" href="/install/raspberry-pi">ARM self-hosted</Card>
</CardGroup>

**AWS (EC2 / Lightsail / free tier)** also works well.
A community video walkthrough is available at
[x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)
(community resource -- may become unavailable).

## How cloud setups work

- The **Gateway runs on the VPS** and owns state + workspace.
- You connect from your laptop or phone via the **Control UI** or **Tailscale/SSH**.
- Treat the VPS as the source of truth and **back up** the state + workspace regularly.
- Secure default: keep the Gateway on loopback and access it via SSH tunnel or Tailscale Serve.
  If you bind to `lan` or `tailnet`, require `gateway.auth.token` or `gateway.auth.password`.

Related pages: [Gateway remote access](/gateway/remote), [Platforms hub](/platforms).

## Shared company agent on a VPS

Running a single agent for a team is a valid setup when every user is in the same trust boundary and the agent is business-only.

- Keep it on a dedicated runtime (VPS/VM/container + dedicated OS user/accounts).
- Do not sign that runtime into personal Apple/Google accounts or personal browser/password-manager profiles.
- If users are adversarial to each other, split by gateway/host/OS user.

Security model details: [Security](/gateway/security).

## Using nodes with a VPS

You can keep the Gateway in the cloud and pair **nodes** on your local devices
(Mac/iOS/Android/headless). Nodes provide local screen/camera/canvas and `system.run`
capabilities while the Gateway stays in the cloud.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

## Startup tuning for small VMs and ARM hosts

If CLI commands feel slow on low-power VMs (or ARM hosts), enable Node's module compile cache:

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF'
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

- `NODE_COMPILE_CACHE` improves repeated command startup times.
- `OPENCLAW_NO_RESPAWN=1` avoids extra startup overhead from a self-respawn path.
- First command run warms the cache; subsequent runs are faster.
- For Raspberry Pi specifics, see [Raspberry Pi](/install/raspberry-pi).

### systemd tuning checklist (optional)

For VM hosts using `systemd`, consider:

- Add service env for a stable startup path:
  - `OPENCLAW_NO_RESPAWN=1`
  - `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache`
- Keep restart behavior explicit:
  - `Restart=always`
  - `RestartSec=2`
  - `TimeoutStartSec=90`
- Prefer SSD-backed disks for state/cache paths to reduce random-I/O cold-start penalties.

Example:

```bash
sudo systemctl edit openclaw
```

```ini
[Service]
Environment=OPENCLAW_NO_RESPAWN=1
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=2
TimeoutStartSec=90
```

How `Restart=` policies help automated recovery:
[systemd can automate service recovery](https://www.redhat.com/en/blog/systemd-automate-recovery).

## Corporate proxy and SSL inspection

If your VPS runs behind a corporate proxy with SSL inspection (common in enterprise networks),
you need to configure environment variables explicitly in your systemd service file.

### Key issues

1. **systemd services don't read `/etc/environment`** — environment variables must be set
   explicitly in the service file using `Environment=` directives.

2. **Proxy environment variable case sensitivity** — some Node.js libraries (like `undici`)
   check only uppercase `HTTP_PROXY`/`HTTPS_PROXY`, while others check lowercase variants.
   **Best practice: set both.**

3. **SSL certificate trust** — corporate proxies often perform SSL inspection (MITM), which
   causes Node.js to reject connections with `SELF_SIGNED_CERT_IN_CHAIN` errors. You must
   point Node.js to your corporate CA certificate.

### Configuration example

Edit your systemd service override:

```bash
sudo systemctl edit openclaw
```

Add the following environment variables:

```ini
[Service]
# Proxy configuration (set both uppercase and lowercase)
Environment=HTTP_PROXY=http://proxy.example.com:3127
Environment=HTTPS_PROXY=http://proxy.example.com:3127
Environment=http_proxy=http://proxy.example.com:3127
Environment=https_proxy=http://proxy.example.com:3127

# Corporate CA certificate for SSL inspection
Environment=NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem

# Optional: bypass proxy for internal hosts
Environment=no_proxy=127.0.0.1,localhost,.internal.example.com
Environment=NO_PROXY=127.0.0.1,localhost,.internal.example.com
```

After editing, reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart openclaw
```

### Troubleshooting

If LLM requests still fail after configuration:

1. **Verify proxy connectivity** with curl:

   ```bash
   curl -v --proxy http://proxy.example.com:3127 https://api.anthropic.com
   ```

2. **Check process environment** (verify vars are loaded):

   ```bash
   sudo cat /proc/$(pgrep -fn openclaw)/environ | tr '\0' '\n' | grep -i proxy
   ```

3. **Check OpenClaw logs for proxy/TLS errors** (no extra Node packages required):

   ```bash
   sudo journalctl -u openclaw -n 200 --no-pager | grep -Ei 'SELF_SIGNED_CERT_IN_CHAIN|CERT|ECONN|ETIMEDOUT|timeout|proxy'
   ```

   - If you see `SELF_SIGNED_CERT_IN_CHAIN`, verify `NODE_EXTRA_CA_CERTS` points to the correct CA file.
   - If you see timeout/connection errors, verify the proxy URL and network reachability.
