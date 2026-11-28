#!/usr/bin/env bash
set -euo pipefail

plugin_id=openclaw.desktop
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
config_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/omarchy
plugin_dir=$config_dir/plugins/$plugin_id

for command in python3 omarchy omarchy-shell; do
  command -v "$command" >/dev/null || { echo "Missing $command. Install Omarchy 4 and Python 3 first." >&2; exit 1; }
done
python3 -c 'from gi.repository import Gio, GLib' 2>/dev/null || {
  echo "Missing Python GObject bindings. Install python-gobject, then run this installer again." >&2
  exit 1
}
omarchy plugin validate "$source_dir"

# Backups cover only this install's destination and the shell layout it enables.
# Keep other user plugins and their placements under their existing ownership.
backup_dir=""
backup() {
  if [[ -z $backup_dir ]]; then
    mkdir -p "$config_dir/backups"
    backup_dir=$(mktemp -d "$config_dir/backups/openclaw-desktop.XXXXXXXX")
  fi
  cp -a -- "$1" "$backup_dir/$2"
}
files=(manifest.json Panel.qml Service.qml CritterIcon.qml bridge.py README.md)
for file in "${files[@]}"; do
  [[ -f $source_dir/$file ]] || { echo "Missing plugin source: $source_dir/$file" >&2; exit 1; }
done
changed=false
for file in "${files[@]}"; do
  if ! cmp -s "$source_dir/$file" "$plugin_dir/$file"; then changed=true; break; fi
done
if $changed; then
  [[ ! -d $plugin_dir ]] || backup "$plugin_dir" plugin
  mkdir -p "$plugin_dir"
  for file in "${files[@]}"; do
    install -m 644 "$source_dir/$file" "$plugin_dir/$file"
  done
fi
[[ ! -f $config_dir/shell.json ]] || backup "$config_dir/shell.json" shell.json
omarchy-shell shell rescanPlugins >/dev/null
omarchy plugin enable "$plugin_id"
echo "Enabled OpenClaw. Open its monochrome icon in the Omarchy bar."
[[ -z $backup_dir ]] || echo "Previous files: $backup_dir"
