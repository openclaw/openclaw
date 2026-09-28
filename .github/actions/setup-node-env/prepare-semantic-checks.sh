#!/usr/bin/env bash
# Trusted CI setup owns privileged user-manager provisioning; tool wrappers never do.
set -euo pipefail
user="$(id -un)"
uid="$(id -u)"

test "$(ps -p 1 -o comm= | xargs)" = systemd
sudo systemctl is-active --quiet systemd-logind.service
sudo loginctl enable-linger "$user"
sudo systemctl start "user@${uid}.service"

runtime_dir="$(loginctl show-user "$user" --property=RuntimePath --value)"
test -n "$runtime_dir"
test -d "$runtime_dir"
test -O "$runtime_dir"

export XDG_RUNTIME_DIR="$runtime_dir"
test -S "$XDG_RUNTIME_DIR/systemd/private"
echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >> "$GITHUB_ENV"

if [[ -S "$runtime_dir/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${runtime_dir}/bus"
  echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"
fi

systemctl --user show-environment >/dev/null

# The user manager must actually enforce the memory controller, not merely exist.
grep -qw memory /sys/fs/cgroup/cgroup.controllers
systemd-run --user --scope --collect --quiet --expand-environment=no \
  --property=MemoryMax=67108864 --property=MemorySwapMax=0 \
  --property=OOMPolicy=kill --property=RuntimeMaxSec=10 -- bash -c '
    set -euo pipefail
    group=$(awk -F: "\$1 == 0 { print \$3 }" /proc/self/cgroup)
    test -n "$group"
    test "$(cat "/sys/fs/cgroup$group/memory.max")" = 67108864
    test "$(cat "/sys/fs/cgroup$group/memory.swap.max")" = 0
    test "$(cat "/sys/fs/cgroup$group/memory.oom.group")" = 1
  '
