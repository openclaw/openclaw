#!/usr/bin/env bash

openclaw_live_stage_source_tree() {
  local dest_dir="${1:?destination directory required}"

  tar -C /src \
    --exclude=.git \
    --exclude=node_modules \
    --exclude=dist \
    --exclude=ui/dist \
    --exclude=ui/node_modules \
    --exclude=.pnpm-store \
    --exclude=.tmp \
    --exclude=.tmp-precommit-venv \
    --exclude=.worktrees \
    --exclude=__openclaw_vitest__ \
    --exclude='apps/*/.build' \
    --exclude='apps/*/*.bun-build' \
    --exclude='apps/*/.gradle' \
    --exclude='apps/*/.kotlin' \
    --exclude='apps/*/build' \
    -cf - . | tar -C "$dest_dir" -xf -
}

openclaw_live_link_runtime_tree() {
  local dest_dir="${1:?destination directory required}"

  ln -s /app/node_modules "$dest_dir/node_modules"
  ln -s /app/dist "$dest_dir/dist"
  if [ -d /app/dist-runtime/extensions ]; then
    export OPENCLAW_BUNDLED_PLUGINS_DIR=/app/dist-runtime/extensions
  elif [ -d /app/dist/extensions ]; then
    export OPENCLAW_BUNDLED_PLUGINS_DIR=/app/dist/extensions
  fi
}
