#!/usr/bin/env bash
set -euo pipefail
umask 077
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/run.mjs" "$@"
