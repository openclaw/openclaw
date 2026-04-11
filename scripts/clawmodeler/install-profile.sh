#!/usr/bin/env bash
set -euo pipefail

profile="${1:-standard}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$profile" in
  light|standard|full|gpu)
    requirements="$repo_root/clawmodeler-requirements-$profile.txt"
    ;;
  *)
    echo "usage: $0 {light|standard|full|gpu}" >&2
    exit 2
    ;;
esac

python_bin="${PYTHON:-python3}"

echo "Installing ClawModeler $profile Python profile with $python_bin"
"$python_bin" -m pip install -r "$requirements"

echo
echo "Profile install complete. Run:"
echo "  openclaw clawmodeler doctor"
