#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
python_bin="${PYTHON_BIN:-python3}"
venv_dir="${CLAWMODELER_SIDECAR_VENV:-$repo_root/.tmp/clawmodeler-sidecar-venv}"
dist_dir="$repo_root/packages/clawmodeler-desktop/src-tauri/binaries"
work_dir="$repo_root/.tmp/clawmodeler-sidecar-pyinstaller"

mkdir -p "$dist_dir" "$work_dir" "$repo_root/.tmp"
launcher="$work_dir/clawmodeler-engine-launcher.py"

cat >"$launcher" <<'PY'
from clawmodeler_engine.cli import main

raise SystemExit(main())
PY

if [ ! -x "$venv_dir/bin/python" ]; then
  "$python_bin" -m venv "$venv_dir"
fi

"$venv_dir/bin/python" -m pip install --upgrade pip setuptools wheel pyinstaller
"$venv_dir/bin/python" -m pip install -e "$repo_root"

rm -f "$dist_dir/clawmodeler-engine"

"$venv_dir/bin/pyinstaller" \
  --clean \
  --noconfirm \
  --onefile \
  --name clawmodeler-engine \
  --distpath "$dist_dir" \
  --workpath "$work_dir/build" \
  --specpath "$work_dir" \
  --paths "$repo_root" \
  --add-data "$repo_root/clawmodeler_engine/toolbox.default.json:clawmodeler_engine" \
  "$launcher"

"$dist_dir/clawmodeler-engine" --version >/dev/null

echo "Built $dist_dir/clawmodeler-engine"
