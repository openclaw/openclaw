#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
DIST_DIR="$ROOT/dist/control-ui"
NPM_ROOT_DEFAULT=$(npm root -g)
INSTALLED_DIR="${OPENCLAW_INSTALLED_DIR:-$NPM_ROOT_DEFAULT/openclaw/dist/control-ui}"
SERVICE="${OPENCLAW_GATEWAY_SERVICE:-openclaw-gateway.service}"
SHIM_DIR="/tmp/openclaw-pnpm-shim"

export DIST_DIR INSTALLED_DIR

mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/pnpm" <<'SH'
#!/usr/bin/env bash
exec corepack pnpm "$@"
SH
chmod +x "$SHIM_DIR/pnpm"

export PATH="$SHIM_DIR:$PATH"

cd "$ROOT"

echo '[1/4] Building control UI from source...'
node scripts/ui.js build

echo '[2/4] Syncing built control UI into installed package...'
rm -rf "$INSTALLED_DIR"
mkdir -p "$INSTALLED_DIR"
cp -R "$DIST_DIR"/. "$INSTALLED_DIR"/

echo '[3/4] Restarting OpenClaw gateway service...'
systemctl --user restart "$SERVICE"
sleep 3

echo '[4/4] Verifying live service and deployed UI shell...'
systemctl --user --no-pager --full status "$SERVICE"
python3 - <<'PY'
from pathlib import Path
import os
src = Path(os.environ['DIST_DIR'])
inst = Path(os.environ['INSTALLED_DIR'])
index_src = src / 'index.html'
index_inst = inst / 'index.html'
print('built_exists', index_src.exists())
print('installed_exists', index_inst.exists())
print('installed_dir', inst)
if index_src.exists() and index_inst.exists():
    built = index_src.read_text()
    installed = index_inst.read_text()
    print('same_index', built == installed)
    print('built_len', len(built))
    print('installed_len', len(installed))
PY

echo 'Done.'
