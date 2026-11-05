---
summary: "Jetson-specific preparation for hosting an OpenClaw Gateway on Linux ARM64"
read_when:
  - Setting up OpenClaw on an NVIDIA Jetson
  - Checking Jetson power, memory, or headless service behavior
title: "NVIDIA Jetson"
---

Run OpenClaw on a Jetson using the standard Linux installation. Start with a
cloud model provider; running a local model server is a separate setup with its
own memory and GPU requirements.

## Prepare the Jetson

1. Install a JetPack release supported by your module and carrier board. Follow
   [NVIDIA's JetPack instructions](https://developer.nvidia.com/embedded/jetpack)
   or [SDK Manager](https://developer.nvidia.com/sdk-manager) for flashing and
   storage options. JetPack versions support different boards; this guide does
   not certify every Jetson module or image.
2. Use a 64-bit Linux image. Check `uname -m`; it should report `aarch64`.
3. Check the [Node.js requirements](/install/node). Use a supported Node release
   and linked SQLite library, rather than assuming the image's distro Node is
   compatible. The [OpenClaw installer](/install#recommended-installer-script)
   checks the runtime and installs Node when needed.
4. Use storage, cooling, and a power supply appropriate for your board. Consider
   an SSD for an always-on host when the board supports it.

## Install and connect

Follow [Getting Started](/start/getting-started) for installation, onboarding,
and verification. For a headless Jetson, the
[Linux CLI and SSH instructions](/platforms/linux#cli-and-ssh-alternative)
cover service installation and an SSH tunnel to the Control UI. Keep the
Gateway on loopback when using that tunnel.

Linux onboarding attempts to enable systemd lingering so the user service can
survive logout. If that step fails or the Gateway stops after logout, follow the
[Gateway service guidance](/gateway#supervision-and-service-lifecycle) to check
lingering and the user session bus. This is standard Linux service behavior.

## Jetson diagnostics

On JetPack images that include NVIDIA's tools:

```bash
sudo nvpmodel -q
tegrastats
```

`nvpmodel -q` displays the current power mode. `tegrastats` reports resource use
and temperatures; press Ctrl+C to stop it. Power-mode IDs and limits vary by
module and image. Follow the power and performance documentation for your
JetPack release before changing modes or clocks; see NVIDIA's
[Jetson Linux Developer Guide](https://docs.nvidia.com/jetson/).

If the host runs out of memory, inspect available RAM and swap with `free -h`
and `swapon --show`. Compressed RAM swap (zram) shares physical memory with the
rest of the system. Size a local-model workload for the memory actually
available to it; an OpenClaw installation does not validate GPU inference
compatibility or model capacity.

## Next steps

- [Local models](/gateway/local-models) — connect a separately configured model server
- [Linux server](/vps) — remote access and server operation
- [Backups](/install/backups) — preserve configuration, state, and workspace
- [Updating](/install/updating) — keep OpenClaw up to date
