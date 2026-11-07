#!/bin/sh
set -eu

scripts_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
installer="$scripts_dir/install-driver-root.sh"
applescript="$scripts_dir/install-driver.applescript"

fail() {
  echo "$1" >&2
  exit 1
}

# The paired driver must build against a deployment target every supported Xcode
# accepts. Xcode 27 rejects a target below 12.0 as a hard error, so the build
# setting is pinned rather than inherited from the pinned BlackHole project.
target=$(/usr/bin/grep -E '^[[:space:]]*MACOSX_DEPLOYMENT_TARGET=' "$installer" |
  /usr/bin/head -1 | /usr/bin/cut -d= -f2 | /usr/bin/tr -d "[:space:]\\\\\"")
if [ -z "$target" ]; then
  fail "install-driver-root.sh does not pin MACOSX_DEPLOYMENT_TARGET"
fi
if ! /usr/bin/awk -v target="$target" 'BEGIN { exit !(target + 0 >= 12.0) }'; then
  fail "install-driver-root.sh pins MACOSX_DEPLOYMENT_TARGET=$target, below the 12.0 minimum Xcode 27 accepts"
fi

# The installer is checksum-pinned by the privileged wrapper. Editing the
# installer without updating that pin makes every install abort on mismatch.
actual=$(/usr/bin/shasum -a 256 "$installer" | /usr/bin/awk '{print $1}')
pinned=$(/usr/bin/sed -n 's/^[[:space:]]*set expectedInstallerDigest to "\([0-9a-f]*\)"$/\1/p' "$applescript")
if [ -z "$pinned" ]; then
  fail "install-driver.applescript does not pin expectedInstallerDigest"
fi
if [ "$pinned" != "$actual" ]; then
  echo "expectedInstallerDigest does not match install-driver-root.sh" >&2
  echo "  pinned: $pinned" >&2
  echo "  actual: $actual" >&2
  exit 1
fi

echo "driver deployment target $target and installer digest pin agree"
