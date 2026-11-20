#!/bin/sh
set -eu
# Railway volumes mount as root, while OpenClaw runs as UID 1000.
# Repair ownership only of known directory entrypoints, without deleting state.
state_dir=/home/node/.openclaw
if [ "$(id -u)" = 0 ]; then
  if [ "${RAILWAY_VOLUME_MOUNT_PATH:-}" = "$state_dir" ]; then
    if [ ! -d "$state_dir" ] || [ -L "$state_dir" ]; then
      echo "OpenClaw state mount missing or unsafe" >&2
      exit 1
    fi
    chown node:node "$state_dir"
    for name in control workspace agents credentials sessions tmp; do
      dir="$state_dir/$name"
      if [ -d "$dir" ] && [ ! -L "$dir" ]; then
        chown node:node "$dir"
      fi
    done
  fi
  exec runuser -u node -- "$@"
fi
exec "$@"
