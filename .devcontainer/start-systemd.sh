#!/bin/bash
# Bootstrap systemd --user inside a Codespace container.
# Called by devcontainer.json postStartCommand with sudo.
#
# Why not systemd --system?  PID 1 is docker-init (required by Codespaces).
# systemd --system hard-exits when getpid() != 1, so only user mode is viable.
#
# What this script does:
#   1. Starts D-Bus system daemon (needed for various systemd user services)
#   2. Starts systemd-journald (provides the journal socket for stdout/stderr)
#   3. Delegates a cgroup v2 subtree to the codespace user
#   4. Launches systemd --user from inside that delegated cgroup
#   5. Waits for the user manager to become ready
set -euo pipefail

CS_USER="codespace"
CS_UID=$(id -u "$CS_USER")
CS_GID=$(id -g "$CS_USER")
XDG_RUNTIME_DIR="/run/user/${CS_UID}"

# ── Already running? ──────────────────────────────────────────────
if sudo -u "$CS_USER" \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" \
    systemctl --user is-system-running 2>/dev/null | grep -qE "running|degraded"; then
    echo "systemd --user already running for $CS_USER"
    exit 0
fi

# ── 1. D-Bus system bus ──────────────────────────────────────────
# Several systemd user services (timedatectl, etc.) expect the system bus.
if [ ! -S /run/dbus/system_bus_socket ]; then
    echo "[1/5] Starting D-Bus system daemon..."
    mkdir -p /run/dbus
    rm -f /run/dbus/pid          # stale pid file from previous run
    dbus-daemon --system --fork
else
    echo "[1/5] D-Bus system daemon already running."
fi

# ── 2. Journal daemon ───────────────────────────────────────────
# Start systemd-journald so the journal stdout socket exists at
# /run/systemd/journal/stdout. Without this, every service that
# connects stdout/stderr to the journal emits:
#   "Failed to connect stdout to the journal socket, ignoring"
if [ ! -S /run/systemd/journal/stdout ]; then
    echo "[2/5] Starting systemd-journald..."
    mkdir -p /run/systemd/journal

    # Persistent journal storage: create machine-id directory so journalctl
    # can read logs. The directory must be owned by root:systemd-journal.
    MACHINE_ID=$(cat /etc/machine-id 2>/dev/null || echo "")
    if [ -n "$MACHINE_ID" ]; then
        # Persistent storage (survives reboot if /var is retained)
        mkdir -p "/var/log/journal/$MACHINE_ID"
        chown root:systemd-journal "/var/log/journal/$MACHINE_ID"
        chmod 2755 "/var/log/journal/$MACHINE_ID"

        # Volatile storage (journald's default location under /run).
        # We pre-create with correct group so journald inherits the perms.
        mkdir -p "/run/log/journal/$MACHINE_ID"
        chown root:systemd-journal "/run/log/journal/$MACHINE_ID"
        chmod 2750 "/run/log/journal/$MACHINE_ID"
    fi

    # Add codespace user to systemd-journal group so journalctl --user works.
    if ! id -nG "$CS_USER" | grep -qw systemd-journal; then
        usermod -aG systemd-journal "$CS_USER" 2>/dev/null || true
    fi

    /lib/systemd/systemd-journald &
    # Wait briefly for the socket to appear (typically <100 ms).
    for _i in $(seq 1 20); do
        [ -S /run/systemd/journal/stdout ] && break
        sleep 0.1
    done
    if [ -S /run/systemd/journal/stdout ]; then
        echo "       journal socket ready."
    else
        echo "       WARNING: journal socket did not appear within 2 s."
    fi
else
    echo "[2/5] systemd-journald already running."
fi

# ── 3. Cgroup v2 delegation ─────────────────────────────────────
# systemd --user needs a delegated cgroup subtree it can write to.
# Without this, it fails with "Failed to create … control group: Permission denied".
#
# We replicate what logind would normally do:
#   /sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/
# systemd --user reads /proc/self/cgroup, finds itself in that cgroup, and
# creates init.scope (and other units) underneath it.
echo "[3/5] Delegating cgroup subtree to $CS_USER..."

CG_ROOT="/sys/fs/cgroup"

# Mount cgroup2 if not already present (privileged containers have access).
if ! mountpoint -q "$CG_ROOT" 2>/dev/null; then
    mount -t cgroup2 none "$CG_ROOT" || true
fi

USER_SLICE="$CG_ROOT/user.slice"
USER_SLICE_UID="$USER_SLICE/user-${CS_UID}.slice"
# This is the cgroup where systemd --user will live — equivalent to
# user@1000.service that logind would create.
USER_MGR_CG="$USER_SLICE_UID/user@${CS_UID}.service"

mkdir -p "$USER_SLICE" "$USER_SLICE_UID"

# Clean up stale child cgroups from a previous systemd --user session.
# cgroup v2's "no internal processes" rule prevents placing a PID in a
# cgroup that has children with subtree_control enabled. After the user
# manager is killed, its child scopes/slices are empty — rmdir them
# (depth-first so nested dirs are removed before parents).
for cg_dir in "$USER_MGR_CG" "$USER_SLICE_UID"; do
    if [ -d "$cg_dir" ]; then
        find "$cg_dir" -mindepth 1 -depth -type d -print0 2>/dev/null | \
            while IFS= read -r -d '' child; do
                procs="$child/cgroup.procs"
                if [ -f "$procs" ]; then
                    # Only remove empty cgroups (no processes)
                    count=$(wc -l < "$procs" 2>/dev/null || echo 0)
                    [ "$count" -eq 0 ] && rmdir "$child" 2>/dev/null || true
                fi
            done
    fi
done
# Remove the manager cgroup itself if stale (empty), so we get a clean slate.
if [ -d "$USER_MGR_CG" ]; then
    procs="$USER_MGR_CG/cgroup.procs"
    if [ -f "$procs" ]; then
        count=$(wc -l < "$procs" 2>/dev/null || echo 0)
        [ "$count" -eq 0 ] && rmdir "$USER_MGR_CG" 2>/dev/null || true
    fi
fi

# Now create the manager cgroup fresh (no stale subtree_control or children).
mkdir -p "$USER_MGR_CG"

# Enable controllers down the hierarchy so the user cgroups inherit them.
# We must push controllers through each level of the tree.
for dir in "$CG_ROOT" "$USER_SLICE" "$USER_SLICE_UID"; do
    avail=$(cat "$dir/cgroup.controllers" 2>/dev/null || true)
    ctrl=""
    for c in cpu cpuset io memory pids; do
        if echo "$avail" | grep -qw "$c"; then
            ctrl="$ctrl +$c"
        fi
    done
    [ -n "$ctrl" ] && echo "$ctrl" > "$dir/cgroup.subtree_control" 2>/dev/null || true
done

# Delegate: give the user ownership of their entire subtree.
chown -R "$CS_UID:$CS_GID" "$USER_SLICE_UID"

# ── 4. XDG_RUNTIME_DIR ──────────────────────────────────────────
echo "[4/5] Setting up XDG_RUNTIME_DIR ($XDG_RUNTIME_DIR)..."
mkdir -p "$XDG_RUNTIME_DIR"
chown "$CS_UID:$CS_GID" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# ── 5. Start systemd --user ─────────────────────────────────────
# The process must be in the delegated cgroup BEFORE exec'ing systemd, because
# systemd --user reads /proc/self/cgroup to find its management scope.
#
# We move the shell into user@1000.service as root (to avoid EBUSY/EPERM on
# the cgroup.procs write), then exec systemd --user as the codespace user.
echo "[5/5] Starting systemd --user for $CS_USER..."

/bin/bash -c '
    # Move this process into the user manager cgroup (must be done as root).
    echo $$ > '"$USER_MGR_CG"'/cgroup.procs
    # Drop privileges and exec systemd --user.
    exec sudo -u '"$CS_USER"' \
        XDG_RUNTIME_DIR='"$XDG_RUNTIME_DIR"' \
        DBUS_SESSION_BUS_ADDRESS="unix:path='"$XDG_RUNTIME_DIR"'/bus" \
        /lib/systemd/systemd --user
' &
SYSTEMD_PID=$!

# ── Wait for readiness (up to 30 s) ─────────────────────────────
echo "Waiting for systemd --user (PID $SYSTEMD_PID) to become ready..."
ready=false
for i in $(seq 1 30); do
    state=$(sudo -u "$CS_USER" \
        XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" \
        systemctl --user is-system-running 2>/dev/null || true)
    case "$state" in
        running|degraded)
            echo "systemd --user is ready ($state)."
            ready=true
            break
            ;;
        starting|initializing)
            # still coming up, keep waiting
            ;;
    esac
    sleep 1
done

if ! $ready; then
    echo "WARNING: systemd --user did not reach running/degraded within 30 s (last state: ${state:-unknown})."
    echo "Check: sudo -u $CS_USER XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR systemctl --user status"
fi

# ── Profile snippet ──────────────────────────────────────────────
# Ensure every new shell gets the right env vars for systemctl --user.
PROFILE_SNIPPET="/etc/profile.d/systemd-user.sh"
if [ ! -f "$PROFILE_SNIPPET" ]; then
    cat > "$PROFILE_SNIPPET" << 'EOPROFILE'
# Set up environment for systemd --user (written by start-systemd.sh)
if [ "$(id -u)" = "1000" ]; then
    export XDG_RUNTIME_DIR="/run/user/1000"
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus"
fi
EOPROFILE
fi

echo ""
echo "systemd bootstrap complete."
echo "  systemctl --user status   – check services"
echo "  journalctl --user -f      – follow user journal"
