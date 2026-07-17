#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_driver="$here/native-driver/.build/OpenClawBridge.driver"
installed_driver="/Library/Audio/Plug-Ins/HAL/OpenClawBridge.driver"

if ! test -d "$source_driver"; then
  "$here/build-driver.sh"
fi

if test -e "$installed_driver"; then
  sudo /usr/bin/trash "$installed_driver"
fi
sudo /usr/bin/ditto "$source_driver" "$installed_driver"
sudo /usr/sbin/chown -R root:wheel "$installed_driver"
sudo /bin/chmod -R go-w "$installed_driver"
coreaudiod_pids=$(/usr/bin/pgrep -x coreaudiod || true)
for coreaudiod_pid in $coreaudiod_pids; do
  # launchd immediately recreates coreaudiod. This is the activation flow
  # documented by BlackHole and works with SIP enabled, unlike kickstart -k.
  sudo /bin/kill -9 "$coreaudiod_pid"
done

printf 'Installed OpenClaw-Mic and OpenClaw-Feed. Reconnect any active FaceTime call.\n'
