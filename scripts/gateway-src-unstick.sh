#!/usr/bin/env bash
set -euo pipefail

LOCK_DIR="$(
  node -e 'const os=require("node:os");const path=require("node:path");const uid=typeof process.getuid==="function"?process.getuid():null;process.stdout.write(path.join(os.tmpdir(), uid!=null?`openclaw-${uid}`:"openclaw"));'
)"

if [ -d "$LOCK_DIR" ]; then
  for lock_file in "$LOCK_DIR"/gateway.*.lock; do
    [ -f "$lock_file" ] || continue

    pid="$(
      node -e 'const fs=require("node:fs");const p=process.argv[1];try{const j=JSON.parse(fs.readFileSync(p,"utf8"));if(Number.isInteger(j?.pid)&&j.pid>1) process.stdout.write(String(j.pid));}catch{}' "$lock_file"
    )"

    if [ -n "$pid" ]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.2
      kill -KILL "$pid" 2>/dev/null || true
    fi

    rm -f "$lock_file"
  done
fi

pkill -f openclaw-gateway 2>/dev/null || true
pkill -f "node --import tsx src/entry.ts gateway run" 2>/dev/null || true

echo "gateway source runtime unstuck"
