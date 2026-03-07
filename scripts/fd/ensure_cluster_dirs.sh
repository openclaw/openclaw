#!/usr/bin/env bash
set -euo pipefail

# One-time setup for the shared cluster directory on M4 (storage host).
# Creates the canonical folder structure that all nodes mount via SMB.
#
# Run this ONCE on M4:
#   bash scripts/ensure_cluster_dirs.sh
#
# Physical location: /Users/fdclaw-m4/cluster
# SMB share name:    cluster
# All nodes mount:   ~/cluster

CLUSTER_DIR="${OPENCLAW_CLUSTER_DIR:-$HOME/cluster}"

echo "[ensure_cluster_dirs] cluster dir: $CLUSTER_DIR"

mkdir -p "$CLUSTER_DIR/bin"
mkdir -p "$CLUSTER_DIR/jobs"
mkdir -p "$CLUSTER_DIR/logs"
mkdir -p "$CLUSTER_DIR/results"

echo "[ensure_cluster_dirs] created:"
ls -1d "$CLUSTER_DIR"/*/

# Convenience symlink (M4 only): ~/cluster -> /Users/fdclaw-m4/cluster
# Skip if already exists or if we're already at ~/cluster
if [ "$CLUSTER_DIR" != "$HOME/cluster" ] && [ ! -e "$HOME/cluster" ]; then
  ln -sf "$CLUSTER_DIR" "$HOME/cluster"
  echo "[ensure_cluster_dirs] symlink: ~/cluster -> $CLUSTER_DIR"
fi

echo "[ensure_cluster_dirs] done"
