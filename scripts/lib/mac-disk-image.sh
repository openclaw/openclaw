#!/bin/bash
# Disk image helpers for macOS-only scripts (Bash 3.2).
#
# On a busy host `hdiutil attach` can fail with EAGAIN after creating the image's
# devices but before mounting, so mount-path cleanup misses the attachment.

# Print the whole-disk device of each attachment of image $1.
disk_image_devices() {
  /usr/bin/python3 - "$1" <<'PY'
import os
import plistlib
import re
import subprocess
import sys

target = os.path.realpath(sys.argv[1])
info = subprocess.run(["hdiutil", "info", "-plist"], stdout=subprocess.PIPE)
if info.returncode:
    raise SystemExit(f"ERROR: hdiutil info failed with exit code {info.returncode}; cannot verify {target} is detached")
for image in plistlib.loads(info.stdout).get("images", []):
    image_path = image.get("image-path")
    # hdiutil reports the path as passed to attach; the first whole disk owns the image.
    if not image_path or os.path.realpath(image_path) != target:
        continue
    for entity in image.get("system-entities", []):
        device = entity.get("dev-entry", "")
        if re.fullmatch(r"/dev/disk[0-9]+", device):
            print(device)
            break
    else:
        raise SystemExit(f"ERROR: disk image has no whole-disk device: {image_path}")
PY
}

# Detach every attachment of image $1 by device; fail if any stays attached.
detach_disk_image() {
  local image="$1" devices device
  devices="$(disk_image_devices "$image")" || return 1
  [[ -n "$devices" ]] || return 0
  while IFS= read -r device; do
    # Detaching a device that is already gone fails; the re-query below decides.
    hdiutil detach -quiet "$device" >/dev/null 2>&1 || true
  done <<< "$devices"
  devices="$(disk_image_devices "$image")" || return 1
  if [[ -n "$devices" ]]; then
    echo "ERROR: disk image $image is still attached; detach it with: hdiutil detach $(printf '%s' "$devices" | tr '\n' ' ')" >&2
    return 1
  fi
}
