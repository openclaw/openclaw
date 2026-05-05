---
summary: "Run OpenClaw in a sandboxed VirtualBox VM (macOS or Linux)"
read_when:
  - You want OpenClaw fully isolated from your host system
  - You want a cross-platform VM that works on macOS and Linux
  - You want headless hosting on a Mac Mini or home server
title: "VirtualBox VM"
---

# OpenClaw on VirtualBox (Sandboxing)

## Recommended default (most users)

- **Small Linux VPS** for an always-on Gateway and low cost. See [VPS hosting](/vps).
- **Dedicated hardware** (Mac mini or Linux box) if you want full control and a **residential IP** for browser automation. Many sites block data center IPs, so local browsing often works better.
- **Hybrid:** keep the Gateway on a cheap VPS, and connect your Mac as a **node** when you need browser/UI automation. See [Nodes](/nodes) and [Gateway remote](/gateway/remote).

Use a VirtualBox VM when you want strict isolation on your existing machine without switching to a cloud provider, or when you want a portable, reproducible environment that works on both macOS and Linux.

## Why VirtualBox

- VirtualBox is free, open-source virtualization software
- Works on **macOS** (Intel + Apple Silicon) and **Linux** (Debian, Fedora, Arch)
- Full VM boundary — **no shared folders**, hardened **UFW firewall**
- Headless by default — deploy on a server, manage entirely over SSH

---

## Quick path (experienced users)

1. `curl -sSL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/virtualbox/install.sh | bash`
2. `openclaw-vm start`
3. `openclaw-vm ssh`
4. `openclaw onboard`
5. `openclaw gateway`
6. Visit `http://localhost:18789` or use `openclaw tui`

---

## What you need

- macOS (Intel or Apple Silicon) or Linux (Debian, Fedora, Arch)
- ~20 GB free disk space (more if installing Ollama)
- ~15 minutes

VirtualBox and Vagrant are installed automatically by the installer.

---

## 1) Install

```bash
curl -sSL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/virtualbox/install.sh | bash
```

or

```bash
git clone https://github.com/openclaw/openclaw
cd scripts/virtualbox
bash install.sh
```

This detects your OS and installs VirtualBox and Vagrant using the appropriate package manager (Homebrew on macOS, apt/dnf/pacman on Linux), clones the repo, and adds `openclaw-vm` to your PATH.

Verify:

```bash
openclaw-vm help
```

---

## 2) Start the VM

```bash
openclaw-vm start
```

On first run, an interactive wizard asks for VM resources (RAM, CPUs), whether to install Ollama, and an optional SSH password for remote access. The VM then boots and provisions automatically with a progress bar.

To skip the wizard and use defaults:

```bash
openclaw-vm config --ram 8192 --cpus 4
openclaw-vm start
```

---

## 3) Configure OpenClaw

SSH into the VM and run the interactive onboarding:

```bash
openclaw-vm ssh
openclaw onboard
```

This walks you through selecting a model provider (Anthropic, OpenAI, OpenRouter, etc.), entering API keys, and configuring the gateway. It generates a secure gateway token automatically.

If you already have a config file from another machine, import it at start:

```bash
openclaw-vm start --config ~/openclaw.json
```

Validate your config at any time:

```bash
openclaw config validate
```

---

## 4) Start the Gateway

Inside the VM:

```bash
openclaw gateway
```

Check it's running:

```bash
openclaw status
```

---

## 5) Interact

Visit **http://localhost:18789** in your browser for WebChat, or use the terminal interface:

```bash
openclaw tui
```

---

## Configure VM resources

Use `openclaw-vm config` to adjust VM settings without recreating it:

```bash
openclaw-vm config --ram 16384 --cpus 8
openclaw-vm config --ollama          # enable local models
openclaw-vm config --no-ollama       # disable local models
openclaw-vm config --password my-pw  # enable SSH password auth

# Apply changes to a running VM
openclaw-vm provision
```

Run `openclaw-vm config` with no flags for the interactive wizard.

---

## Remote access

Host the VM on a Mac Mini or server and SSH in from other devices on your LAN.

### Setup

Set an SSH password via the wizard or CLI:

```bash
openclaw-vm config --password your-strong-password
openclaw-vm provision
```

Then connect from any machine on the network:

```bash
ssh vagrant@<host-ip> -p 2222
```

Password auth is opt-in. If no password is set, SSH uses Vagrant's key-only auth (host only). When enabled, SSH is hardened automatically: root login disabled, max 3 auth attempts.

### Headless mode

The VM runs headlessly by default (no GUI window). Deploy it on a Mac Mini or home server and manage entirely over SSH:

```bash
# On the server
openclaw-vm start
openclaw-vm ssh -c "openclaw gateway"
```

---

## VM lifecycle

```bash
openclaw-vm start       # Create or resume the VM
openclaw-vm stop        # Shut down the VM
openclaw-vm status      # Check VM state and connection info
openclaw-vm ssh         # SSH into the VM
openclaw-vm logs        # View OpenClaw and Ollama logs
openclaw-vm provision   # Re-provision (apply config changes)
openclaw-vm destroy     # Delete the VM and all data
```

`destroy` cleans up both the VM and the generated config directory for a fresh start.

---

## Troubleshooting

| Problem                  | Solution                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `VBoxManage not found`   | Run the installer again, or install VirtualBox manually                               |
| `vagrant not found`      | Run the installer again, or install Vagrant manually                                  |
| VM stuck on "Booting"    | Check VirtualBox settings; ensure virtualization is enabled in BIOS                   |
| Can't reach WebChat      | Verify the VM is running (`openclaw-vm status`) and gateway is up (`openclaw status`) |
| Provision fails          | Run `openclaw-vm provision` again; check `openclaw-vm logs`                           |
| SSH password not working | Set a password with `openclaw-vm config --password` then `openclaw-vm provision`      |

---

## Related docs

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [macOS VMs (Lume)](/install/macos-vm)
- [Docker Sandboxing](/install/docker)
