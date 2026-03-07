#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config"

mkdir -p "$SYSTEMD_DIR" "$ENV_DIR"

cp "$BASE_DIR/pf-main.service" "$SYSTEMD_DIR/pf-main.service"
cp "$BASE_DIR/pf-worker@.service" "$SYSTEMD_DIR/pf-worker@.service"
cp "$BASE_DIR/pf-worker-yt.service" "$SYSTEMD_DIR/pf-worker-yt.service"
cp "$BASE_DIR/pf-worker-trading.service" "$SYSTEMD_DIR/pf-worker-trading.service"
cp "$BASE_DIR/pf-discord-bridge.service" "$SYSTEMD_DIR/pf-discord-bridge.service"

if [ ! -f "$ENV_DIR/pf-main.env" ]; then
  cp "$BASE_DIR/examples/pf-main.env.example" "$ENV_DIR/pf-main.env"
  echo "Created $ENV_DIR/pf-main.env (edit before first run)."
fi

if [ ! -f "$ENV_DIR/pf-worker.env" ]; then
  cp "$BASE_DIR/examples/pf-worker.env.example" "$ENV_DIR/pf-worker.env"
  echo "Created $ENV_DIR/pf-worker.env (edit before first run)."
fi

if [ ! -f "$ENV_DIR/pf-discord.env" ]; then
  cp "$BASE_DIR/examples/pf-discord.env.example" "$ENV_DIR/pf-discord.env"
  echo "Created $ENV_DIR/pf-discord.env (edit before first run)."
fi

systemctl --user daemon-reload
echo "Installed units:"
echo "  - pf-main.service"
echo "  - pf-worker@.service"
echo "  - pf-worker-yt.service"
echo "  - pf-worker-trading.service"
echo "  - pf-discord-bridge.service"
echo
echo "Start main:"
echo "  systemctl --user enable --now pf-main.service"
echo
echo "Start two workers:"
echo "  systemctl --user enable --now pf-worker-yt.service"
echo "  systemctl --user enable --now pf-worker-trading.service"
echo "  systemctl --user enable --now pf-discord-bridge.service"
