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
    for name in control workspace agents credentials sessions tmp client; do
      dir="$state_dir/$name"
      if [ -d "$dir" ] && [ ! -L "$dir" ]; then
        chown node:node "$dir"
      fi
    done
    # The client credential database can arrive root-owned with a restored volume.
    client="$state_dir/client"
    if [ -d "$client" ] && [ ! -L "$client" ]; then
      for name in credentials.sqlite credentials.sqlite-wal credentials.sqlite-shm credentials.sqlite-journal; do
        file="$client/$name"
        if [ -f "$file" ] && [ ! -L "$file" ]; then
          chown -h node:node "$file"
        fi
      done
    fi
  fi
  exec runuser -u node -- "$@"
fi
exec "$@"
