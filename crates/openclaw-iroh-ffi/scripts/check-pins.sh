#!/usr/bin/env bash
# Fail when Cargo.lock drifts off the libc pin that keeps the iOS slices building.
#
# netdev 0.46.0-0.46.3 (iroh 1.4.1 -> netwatch 0.19.3) uses `libc::in6_ifreq` on every
# Apple target. libc 0.2.190 limited that type to macOS, so the iOS slices only build
# with libc 0.2.189. The pin can go once the lockfile carries a netdev without that
# code on iOS (netdev 0.47 already has the macOS-only guard).
set -euo pipefail
cd "$(dirname "$0")/.."

pinned_libc="0.2.189"

# Print every locked version of one package, one per line.
locked_versions() {
  awk -v name="\"$1\"" '
    $1 == "name" && $3 == name { want = 1; next }
    want && $1 == "version" { gsub(/"/, "", $3); print $3; want = 0 }
  ' Cargo.lock
}

libc_versions="$(locked_versions libc)"
netdev_versions="$(locked_versions netdev)"

# Only netdev 0.46.0-0.46.3 needs the pin; other netdev versions are left alone.
if ! grep -Eq '^0\.46\.[0-3]$' <<<"$netdev_versions"; then
  echo "netdev no longer needs the libc pin; update libc and remove scripts/check-pins.sh."
  exit 0
fi

if [[ "$libc_versions" != "$pinned_libc" ]]; then
  echo "::error file=crates/openclaw-iroh-ffi/Cargo.lock::libc must stay at $pinned_libc while netdev 0.46.0-0.46.3 is locked; found: ${libc_versions//$'\n'/, }. See PACKAGING.md." >&2
  exit 1
fi

echo "libc $pinned_libc is pinned for netdev $(grep -E '^0\.46\.' <<<"$netdev_versions")."
