#!/usr/bin/env bash
# update_and_restart.sh – Ubuntu upgrade + Docker restart
# ----------------------------------------------------
# 1. Refresh package index
# 2. Upgrade all installed packages (non‑interactive)
# 3. Restart Docker so any rebuilt containers pick up new env vars
# ----------------------------------------------------
set -euo pipefail

echo "=== Updating Ubuntu package index ==="
sudo apt update

echo "=== Showing upgradable packages (optional) ==="
apt list --upgradable

echo "=== Performing full upgrade (no prompts) ==="
sudo DEBIAN_FRONTEND=noninteractive apt upgrade -y

echo "=== Restarting Docker service ==="
sudo systemctl restart docker

echo "=== Done! System is up‑to‑date and Docker has been restarted. ==="
