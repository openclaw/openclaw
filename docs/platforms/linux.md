---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
title: "Linux App"
---

# Linux App

The Gateway is fully supported on Linux. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

Native Linux companion apps are planned. Contributions are welcome if you want to help build one.

## Beginner quick path (VPS)

1. Install Node 24 (recommended; Node 22 LTS, currently `22.16+`, still works for compatibility)
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. From your laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Open `http://127.0.0.1:18789/` and paste your token

Step-by-step VPS guide: [exe.dev](/install/exe-dev)

## Install

- [Getting Started](/start/getting-started)
- [Install & updates](/install/updating)
- Optional flows: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Use one of these:

```
openclaw onboard --install-daemon
```

Or:

```
openclaw gateway install
```

Or:

```
openclaw configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
openclaw doctor
```

## System control (systemd user unit)

OpenClaw installs a systemd **user** service by default. Use a **system**
service for shared or always-on servers. The full unit example and guidance
live in the [Gateway runbook](/gateway).

Minimal setup:

Create `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

## Running on a desktop Linux server (Ubuntu 24.04+)

This section covers a production setup on a **bare-metal or desktop Ubuntu machine**
with a display, GPU, and always-on connectivity — a common setup for running
OpenClaw as a personal AI server at home or in an office.

### Node version manager (nvm) caveat

If you install Node via `nvm`, systemd **cannot find it** by default because
nvm sets PATH only in interactive shells. Fix: use the absolute path in your
service unit.

```bash
# Find your node path
which node
# e.g. /home/user/.nvm/versions/node/v22.22.0/bin/node

# Find openclaw path
which openclaw
# e.g. /home/user/.nvm/versions/node/v22.22.0/bin/openclaw
```

Then in your service file use the full path:

```ini
[Service]
ExecStart=/home/user/.nvm/versions/node/v22.22.0/bin/openclaw gateway --port 18789
Environment=PATH=/home/user/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=5
```

Alternatively, install a system Node (avoids nvm/systemd friction entirely):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Remote access via Tailscale (recommended over SSH tunnels)

Tailscale gives you a stable private IP across devices without open ports.

```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Expose the dashboard over Tailscale Serve (HTTPS, no open ports)
tailscale serve --bg 18789
```

Your dashboard is then available at `https://<machine-name>.tail<id>.ts.net`
from any device on your Tailscale network.

> **Security note:** keep `{ gateway: { bind: "loopback" } }` in your config.
> Tailscale Serve proxies externally; the Gateway itself never binds to a public interface.

### Using a local GPU with Ollama

If your machine has an NVIDIA GPU, you can run local models via Ollama alongside
cloud models:

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model (example: qwen3:14b fits in 16 GB VRAM)
ollama pull qwen3:14b

# Verify GPU is used
ollama run qwen3:14b "hello"
# should show GPU layers in ollama logs
```

Then add the Ollama provider to your OpenClaw config:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://localhost:11434",
        apiKey: "ollama-local",
        api: "ollama",
        models: [
          {
            id: "qwen3:14b",
            name: "Qwen3 14B (local)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Use `ollama list` to see available models and their VRAM requirements.

### Updating OpenClaw without downtime

```bash
npm i -g openclaw@latest
openclaw gateway restart
# or: systemctl --user restart openclaw-gateway.service
```

The service auto-restarts via `Restart=always`; active sessions resume after reconnect.

### Firewall (ufw)

Keep the Gateway on loopback. Only open ports you explicitly need:

```bash
sudo ufw enable
sudo ufw allow ssh
# Do NOT expose 18789 publicly — use Tailscale or SSH tunnel instead
sudo ufw status
```
