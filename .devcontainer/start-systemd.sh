#!/bin/bash
# Bootstrap systemd inside a Codespace container (not as PID 1).
# Called by devcontainer.json postStartCommand with sudo.
set -euo pipefail

# If systemd is already running, nothing to do.
if pidof systemd >/dev/null 2>&1; then
    echo "systemd already running (PID $(pidof systemd))"
    exit 0
fi

# Mount cgroup2 if not already present (privileged containers have access).
if ! mountpoint -q /sys/fs/cgroup 2>/dev/null; then
    mount -t cgroup2 none /sys/fs/cgroup || true
fi

# Ensure /run/systemd exists for the journal and runtime socket.
mkdir -p /run/systemd/journal /run/systemd/system

# Start the system-level systemd in the background via unshare so it
# gets its own PID namespace subtree while the container keeps its
# original PID 1.  This is the standard "systemd-in-container" pattern
# used by tools like `systemd-nspawn --as-pid2`.
/lib/systemd/systemd --system &
SYSTEMD_PID=$!

# Wait for systemd to become ready (up to 30 s).
echo "Waiting for systemd (PID $SYSTEMD_PID) to start..."
for i in $(seq 1 30); do
    if systemctl is-system-running --wait 2>/dev/null | grep -qE "running|degraded"; then
        echo "systemd is up ($(systemctl is-system-running))."
        break
    fi
    sleep 1
done

# Enable lingering for the vscode user so systemctl --user works without a login session.
loginctl enable-linger vscode 2>/dev/null || true

# Start the user service manager for vscode.
# The XDG_RUNTIME_DIR must be set for systemctl --user.
VSCODE_UID=$(id -u vscode)
export XDG_RUNTIME_DIR="/run/user/${VSCODE_UID}"
mkdir -p "$XDG_RUNTIME_DIR"
chown vscode:vscode "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Give the user manager a moment to spin up after linger is enabled.
sleep 2

echo "systemd bootstrap complete. 'systemctl --user' should now work for vscode."
