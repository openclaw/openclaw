#!/usr/bin/env bash
set -euo pipefail

# Minimal regression test for setup-podman.sh run_as_user safe cwd.
# We don't invoke sudo/runuser here; we just ensure the script contains
# the safe-cwd wrapper so callers in private directories don't fail.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
file="$root/setup-podman.sh"

# Expect the safe_cwd variable and a subshell wrapper around sudo/runuser.
grep -q 'local safe_cwd=' "$file"
grep -q '( cd "$safe_cwd"' "$file"

echo "ok"
