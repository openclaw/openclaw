#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="${1:-$(pwd)/deploy/itplug}"

install -m 0755 "$SRC_DIR/update-from-git.sh" /usr/local/bin/openclaw-itplug-update
install -m 0644 "$SRC_DIR/openclaw-itplug-update.service" /etc/systemd/system/openclaw-itplug-update.service
install -m 0644 "$SRC_DIR/openclaw-itplug-update.timer" /etc/systemd/system/openclaw-itplug-update.timer

systemctl daemon-reload
systemctl enable --now openclaw-itplug-update.timer
systemctl start openclaw-itplug-update.service

systemctl --no-pager --full status openclaw-itplug-update.timer || true
