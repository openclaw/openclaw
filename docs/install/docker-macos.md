---
title: "macOS in Docker (Linux/Windows)"
summary: "Run macOS in Docker on Linux/Windows using QEMU to use OpenClaw with macOS-only features"
read_when:
  - You want to run macOS on Linux or Windows
  - You want iMessage/BlueBubbles without Apple hardware
  - You want a containerized macOS environment
---

# Running macOS in Docker (Linux/Windows)

Run macOS in a Docker container using QEMU on Linux or Windows. This approach uses [Docker-OSX](https://github.com/sickcodes/Docker-OSX) to emulate macOS on non-Apple hardware.

<Warning>
This guide uses third-party community resources (Docker images and pre-built macOS disk images) that are **not maintained or verified by the OpenClaw project**. Review these resources before use and understand the security implications of running containers with elevated privileges.
</Warning>

## When to use this

- You don't have Apple hardware but want macOS-only features (iMessage via BlueBubbles)
- You want a portable, reproducible macOS environment
- You prefer containers over traditional VMs

If you already have a Mac, see [macOS VMs](/install/macos-vm) for native virtualization options.

## What you get

- macOS on Linux/Windows without Apple hardware
- iMessage support via BlueBubbles (once configured)
- Portable, reproducible environment
- Snapshots and easy reset

## Requirements

### Linux

- Modern CPU with virtualization support (Intel VT-x or AMD-V)
- KVM enabled (`/dev/kvm` accessible)
- Docker installed
- ~80 GB free disk space
- 8+ GB RAM recommended

### Windows

- Windows 10/11 with WSL2
- Docker Desktop with WSL2 backend
- ~80 GB free disk space
- 8+ GB RAM recommended

---

## Download macOS image

<Note>
The Hugging Face repository below is a **third-party community resource** not affiliated with or maintained by OpenClaw. Inspect the contents before use.
</Note>

Download the required image files (~40 GB) from Hugging Face:

```bash
pip install huggingface_hub

huggingface-cli download fuyikun/Mac-in-docker-OpenClaw --local-dir .
```

Or using Python:

```python
from huggingface_hub import snapshot_download

snapshot_download(repo_id="fuyikun/Mac-in-docker-OpenClaw", local_dir=".")
```

---

## Start macOS Docker container

<Note>
The Docker image `numbmelon/docker-osx-evalkit-auto` is a **third-party community image** based on [Docker-OSX](https://github.com/sickcodes/Docker-OSX). It is not maintained by OpenClaw. Consider inspecting the image or building your own from the official Docker-OSX repository.
</Note>

<Warning>
**Security considerations:**
- The example uses `password=off` for VNC, which disables authentication. Only use this on trusted local networks. For remote access, enable VNC authentication or use SSH tunneling.
- Change the default `USERNAME` and `PASSWORD` values before any real use.
- The container requires `--device /dev/kvm` for hardware virtualization access.
</Warning>

**For Linux users:**

```bash
# Start the container
sudo docker run -itd \
    --name "macos_openclaw" \
    --device /dev/kvm \
    -p 52272:10022 \
    -p 5902:5902 \
    --add-host=host.docker.internal:host-gateway \
    -e "DISPLAY=${DISPLAY:-:0.0}" \
    -e EXTRA="-vnc 0.0.0.0:2,password=off" \
    -v /tmp/.X11-unix:/tmp/.X11-unix \
    -e CPU='Haswell-noTSX' \
    -e CPUID_FLAGS='kvm=on,vendor=GenuineIntel,+invtsc,vmware-cpuid-freq=on' \
    -v "/path/to/mac_hdd_ng.img:/home/arch/OSX-KVM/mac_hdd_ng_src.img" \
    -v "/path/to/BaseSystem.img:/home/arch/OSX-KVM/BaseSystem_src.img" \
    -e SHORTNAME=tahoe \
    -e USERNAME=test \
    -e PASSWORD='1234' \
    numbmelon/docker-osx-evalkit-auto:latest
```

**For Windows (WSL2) users:**

Run the above command inside your WSL2 Linux distribution. The `/dev/kvm` device and X11 socket paths are Linux-specific. Ensure KVM is enabled in your WSL2 environment.

Replace `/path/to/` with the actual path where you downloaded the image files.

---

## Connect to macOS

### SSH connection

```bash
ssh -p 52272 test@localhost
```

### VNC connection (desktop)

```bash
vncviewer localhost:5902
```

Enter 1234 as password to unlock the desktop.

![macOS desktop](/images/macos.png)

> **Note**: The first connection may take a while as the container fully boots up.

Continue to [macOS App](/start/onboarding) to download and configure the macOS app.

---

## Related docs

- [macOS VMs (native)](/install/macos-vm)
- [Docker installation](/install/docker)
- [BlueBubbles channel](/channels/bluebubbles)
- [Linux platform](/platforms/linux)
- [Docker-OSX GitHub](https://github.com/sickcodes/Docker-OSX)
