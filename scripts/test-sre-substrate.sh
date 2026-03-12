#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SHIM_DIR=""

if ! command -v rg >/dev/null 2>&1; then
  SHIM_DIR="$(mktemp -d)"
  cat >"${SHIM_DIR}/rg" <<'EOF'
#!/usr/bin/env bash
exec grep "$@"
EOF
  chmod +x "${SHIM_DIR}/rg"
  export PATH="${SHIM_DIR}:${PATH}"
fi

for test_script in "$ROOT_DIR"/test/sre-substrate/test-*.sh; do
  bash "$test_script"
done

shopt -u nullglob
if [ -n "$SHIM_DIR" ]; then
  rm -rf "$SHIM_DIR"
fi
