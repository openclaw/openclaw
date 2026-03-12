#!/usr/bin/env bash
# build-rootfs.sh — Build an Alpine-based ext4 rootfs image for Firecracker MicroVMs.
#
# This script requires root privileges (mount/chroot operations).
# Usage: sudo ./build-rootfs.sh [--envd-bin PATH] [--output PATH] [--size SIZE_MB] [--variant base|browser|desktop]
#
# The resulting rootfs.ext4 contains:
#   - Alpine Linux base system with OpenRC init
#   - envd guest agent binary at /usr/local/bin/envd
#   - Development tools: bash, git, curl, jq, python3, nodejs, npm, ripgrep
#   - /workspace directory owned by sandbox user
#   - (browser variant) Chromium with rendering dependencies
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENVD_BIN="${SCRIPT_DIR}/../../envd"
OUTPUT="${SCRIPT_DIR}/rootfs.ext4"
SIZE_MB=256
SIZE_EXPLICIT=false
VARIANT="${VARIANT:-base}"
ALPINE_MIRROR="https://dl-cdn.alpinelinux.org/alpine"
ALPINE_VERSION="v3.21"

# Parse arguments.
while [[ $# -gt 0 ]]; do
    case "$1" in
        --envd-bin) ENVD_BIN="$2"; shift 2 ;;
        --output)   OUTPUT="$2"; shift 2 ;;
        --size)     SIZE_MB="$2"; SIZE_EXPLICIT=true; shift 2 ;;
        --variant)  VARIANT="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

# Validate variant.
case "$VARIANT" in
    base|browser|desktop) ;;
    *) echo "Error: Unknown variant '$VARIANT'. Must be base, browser, or desktop." >&2; exit 1 ;;
esac

# Override default size for browser/desktop variants (unless explicitly set).
if [ "$SIZE_EXPLICIT" = "false" ] && { [ "$VARIANT" = "browser" ] || [ "$VARIANT" = "desktop" ]; }; then
    SIZE_MB=600
fi

# Validate envd binary exists.
if [[ ! -f "$ENVD_BIN" ]]; then
    echo "Error: envd binary not found at $ENVD_BIN" >&2
    echo "Run 'make build-envd' first." >&2
    exit 1
fi

# Require root.
if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root (mount/chroot required)." >&2
    exit 1
fi

MOUNTPOINT=$(mktemp -d)
trap 'cleanup' EXIT

cleanup() {
    set +e
    # Unmount any bind mounts.
    umount "$MOUNTPOINT/proc" 2>/dev/null
    umount "$MOUNTPOINT/dev" 2>/dev/null
    umount "$MOUNTPOINT/sys" 2>/dev/null
    umount "$MOUNTPOINT" 2>/dev/null
    rmdir "$MOUNTPOINT" 2>/dev/null
    set -e
}

echo "==> Creating ${SIZE_MB}MB ext4 image..."
dd if=/dev/zero of="$OUTPUT" bs=1M count="$SIZE_MB" status=progress
mkfs.ext4 -F -L rootfs "$OUTPUT"

echo "==> Mounting image..."
mount -o loop "$OUTPUT" "$MOUNTPOINT"

echo "==> Installing Alpine base system..."
# Install Alpine minirootfs using apk.
mkdir -p "$MOUNTPOINT/etc/apk"
echo "${ALPINE_MIRROR}/${ALPINE_VERSION}/main" > "$MOUNTPOINT/etc/apk/repositories"
echo "${ALPINE_MIRROR}/${ALPINE_VERSION}/community" >> "$MOUNTPOINT/etc/apk/repositories"

apk add --root "$MOUNTPOINT" --initdb --no-cache \
    alpine-base \
    openrc \
    bash \
    git \
    curl \
    jq \
    python3 \
    py3-pip \
    nodejs \
    npm \
    ripgrep \
    ca-certificates \
    openssh-client

# Install browser packages for browser/desktop variants.
if [ "$VARIANT" = "browser" ] || [ "$VARIANT" = "desktop" ]; then
    echo "==> Installing Chromium for ${VARIANT} variant..."
    apk add --root "$MOUNTPOINT" --no-cache \
        chromium \
        nss \
        freetype \
        harfbuzz \
        ca-certificates \
        ttf-freefont \
        font-noto-emoji
fi

echo "==> Configuring init system..."
# Configure OpenRC for Firecracker (no hardware init needed).
mkdir -p "$MOUNTPOINT/etc/init.d"

# Set hostname.
echo "openclaw" > "$MOUNTPOINT/etc/hostname"

# Configure /etc/inittab for serial console.
cat > "$MOUNTPOINT/etc/inittab" << 'INITTAB'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
ttyS0::respawn:/sbin/getty 115200 ttyS0
INITTAB

# Configure fstab.
cat > "$MOUNTPOINT/etc/fstab" << 'FSTAB'
/dev/vda  /         ext4  rw,relatime  0  1
proc      /proc     proc  defaults     0  0
sysfs     /sys      sysfs defaults     0  0
devtmpfs  /dev      devtmpfs defaults  0  0
FSTAB

# Add /dev/shm tmpfs for browser variants (Chromium IPC requires shared memory).
if [ "$VARIANT" = "browser" ] || [ "$VARIANT" = "desktop" ]; then
    mkdir -p "$MOUNTPOINT/dev/shm"
    echo "tmpfs /dev/shm tmpfs defaults,size=128m 0 0" >> "$MOUNTPOINT/etc/fstab"
fi

# Install desktop packages for desktop variant (Xvfb, x11vnc, fluxbox, socat).
if [ "$VARIANT" = "desktop" ]; then
    echo "==> Installing desktop environment for desktop variant..."
    apk add --root "$MOUNTPOINT" --no-cache \
        xvfb x11vnc fluxbox xvfb-run xdpyinfo socat

    # Install desktop OpenRC init scripts.
    cp "$SCRIPT_DIR/desktop.initd" "$MOUNTPOINT/etc/init.d/desktop"
    chmod 755 "$MOUNTPOINT/etc/init.d/desktop"
    ln -sf /etc/init.d/desktop "$MOUNTPOINT/etc/runlevels/default/desktop"

    cp "$SCRIPT_DIR/vnc-vsock.initd" "$MOUNTPOINT/etc/init.d/vnc-vsock"
    chmod 755 "$MOUNTPOINT/etc/init.d/vnc-vsock"
    ln -sf /etc/init.d/vnc-vsock "$MOUNTPOINT/etc/runlevels/default/vnc-vsock"
fi

echo "==> Installing envd guest agent..."
cp "$ENVD_BIN" "$MOUNTPOINT/usr/local/bin/envd"
chmod 755 "$MOUNTPOINT/usr/local/bin/envd"

# Install OpenRC init script for envd.
cp "$SCRIPT_DIR/envd.initd" "$MOUNTPOINT/etc/init.d/envd"
chmod 755 "$MOUNTPOINT/etc/init.d/envd"

# Enable envd service at default runlevel.
mkdir -p "$MOUNTPOINT/etc/runlevels/default"
ln -sf /etc/init.d/envd "$MOUNTPOINT/etc/runlevels/default/envd"

echo "==> Creating workspace and sandbox user..."
# Create sandbox user (uid 1000).
echo "sandbox:x:1000:1000:Sandbox User:/workspace:/bin/bash" >> "$MOUNTPOINT/etc/passwd"
echo "sandbox:x:1000:" >> "$MOUNTPOINT/etc/group"
echo "sandbox:!:0::::::" >> "$MOUNTPOINT/etc/shadow"

# Create workspace directory.
mkdir -p "$MOUNTPOINT/workspace"
chown 1000:1000 "$MOUNTPOINT/workspace"

# Set up basic shell environment for sandbox user.
cat > "$MOUNTPOINT/workspace/.bashrc" << 'BASHRC'
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="/workspace"
cd /workspace
BASHRC
chown 1000:1000 "$MOUNTPOINT/workspace/.bashrc"

echo "==> Setting root password (disabled)..."
# Lock root account — access is via envd only.
chroot "$MOUNTPOINT" /bin/sh -c "passwd -l root" 2>/dev/null || true

echo "==> Cleaning up..."
# Remove apk cache to save space.
rm -rf "$MOUNTPOINT/var/cache/apk"/*

echo "==> Unmounting image..."
umount "$MOUNTPOINT"
rmdir "$MOUNTPOINT"

# Disable the trap since we already cleaned up.
trap - EXIT

echo "==> Rootfs image created: $OUTPUT (${SIZE_MB}MB, variant: ${VARIANT})"
echo "    Alpine ${ALPINE_VERSION} with envd, OpenRC, bash, git, curl, python3, nodejs"
if [ "$VARIANT" = "browser" ] || [ "$VARIANT" = "desktop" ]; then
    echo "    + Chromium, nss, freetype, harfbuzz, ttf-freefont, font-noto-emoji"
fi
if [ "$VARIANT" = "desktop" ]; then
    echo "    + Desktop: Xvfb, x11vnc, fluxbox, socat (OpenRC services enabled)"
fi
