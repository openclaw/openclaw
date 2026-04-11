#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python_bin="${PYTHON:-python3}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/clawmodeler-check.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

cd "$repo_root"

echo "Running ClawModeler sidecar tests with $python_bin"
"$python_bin" -m unittest discover -s test -p 'clawmodeler_engine_test.py'

wheel_dir="$work_dir/wheelhouse"
venv_dir="$work_dir/venv"
mkdir -p "$wheel_dir"

echo
echo "Building ClawModeler wheel"
"$python_bin" -m pip wheel . --no-deps -w "$wheel_dir"

wheel_path="$(find "$wheel_dir" -maxdepth 1 -type f -name 'clawmodeler_engine-*.whl' | sort | head -n 1)"
if [[ -z "$wheel_path" ]]; then
  echo "ClawModeler wheel was not produced." >&2
  exit 1
fi

"$python_bin" - "$wheel_path" <<'PY'
from pathlib import Path
import sys
import zipfile

wheel = Path(sys.argv[1])
required = {
    "clawmodeler_engine/cli.py",
    "clawmodeler_engine/toolbox.default.json",
}
with zipfile.ZipFile(wheel) as archive:
    names = set(archive.namelist())
missing = sorted(required - names)
if missing:
    raise SystemExit(f"missing wheel files: {missing}")
print(f"Verified wheel contents: {wheel.name}")
PY

echo
echo "Installing wheel into temporary venv"
"$python_bin" -m venv "$venv_dir"
"$venv_dir/bin/python" -m pip install --no-deps "$wheel_path"

echo
echo "Checking installed console script"
"$venv_dir/bin/clawmodeler-engine" --version
"$venv_dir/bin/clawmodeler-engine" --help >/dev/null

echo
echo "ClawModeler packaging check passed."
