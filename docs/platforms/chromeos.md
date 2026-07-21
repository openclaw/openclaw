---
summary: "Run the OpenClaw Gateway on ChromeOS inside a Crostini Linux container"
read_when:
  - Installing OpenClaw on a Chromebook or ChromeOS device
  - Debugging missing provider keys or a Gateway that is gone after a reboot
title: "ChromeOS"
---

ChromeOS runs Linux software through **Crostini**, a managed Debian container
that Google exposes as the "Linux development environment". The Gateway runs
inside that container exactly like any other Linux install, so the [Linux
guide](/platforms/linux) applies in full. This page covers the ChromeOS
specific setup and the gotchas that differ from a plain Linux host.

Node is the recommended runtime; Bun is not recommended (known
WhatsApp/Telegram issues).

## Enable the Linux container

Turn on Crostini before installing anything:

1. Open ChromeOS **Settings**.
2. Go to **About ChromeOS** then **Developers**.
3. Next to **Linux development environment**, select **Set up** and follow the
   prompts. ChromeOS downloads the Debian container and opens a **Terminal**.

Run every command below inside that Terminal.

## Quick path

1. Install via the installer script (it installs a supported Node for you):

   ```bash
   curl -fsSL https://openclaw.ai/install.sh | bash
   ```

2. Onboard and install the service:

   ```bash
   openclaw onboard --install-daemon
   ```

3. Confirm the Gateway is running:

   ```bash
   openclaw gateway status
   ```

Full server guidance lives in the [Linux guide](/platforms/linux) and the
[Gateway runbook](/gateway).

## Prefer the native install over Docker

On a single user Chromebook, use the native npm install (the installer script,
or a global `npm i -g openclaw@latest`) rather than [Docker](/install/docker).

Docker works inside Crostini, but Docker in Crostini adds friction: if you use
the Claude Code CLI as your model runtime, it has to be installed and logged in
**inside a persisted container home**, which is easy to lose on a container
rebuild. The native install keeps the CLI and its login on the Crostini
filesystem directly, so a Docker image rebuild cannot wipe it.

## Node version

Debian ships Node 18 by default, which is below the OpenClaw floor of Node
22.19+ (Node 24 recommended). The installer script pulls a supported Node
through NodeSource automatically, so a clean container needs no manual step.

If you installed Node yourself before OpenClaw, upgrade it **before** installing
OpenClaw:

```bash
node -v   # if this shows v18.x, upgrade before continuing
```

See [Node install guidance](/install/node) for the supported versions.

## Provider keys and environment variables

The Gateway runs as a **systemd user service**, so it does not inherit
variables from your interactive shell. A value set with `export VAR=...` in
your shell profile never reaches the running Gateway.

Put provider keys in `~/.openclaw/.env` instead, one per line:

```bash
DEEPSEEK_API_KEY=your-key-here
```

Then restart so the service picks them up:

```bash
openclaw gateway restart
```

See [Configuration reference](/gateway/configuration-reference) for the full
list of environment variables the Gateway reads.

## Crostini is not always on

The Crostini Linux VM runs only while the ChromeOS Linux session is active, and
a ChromeOS reboot does **not** relaunch it automatically. After a reboot the
Gateway is not running until the container starts again.

Reopen the **Terminal** once after a reboot to bring the container (and with it
the Gateway user service) back up, then verify:

```bash
openclaw gateway status
```

## Related

- [Linux guide](/platforms/linux)
- [Install overview](/install)
- [Node install guidance](/install/node)
- [Gateway runbook](/gateway)
- [Gateway configuration](/gateway/configuration)
