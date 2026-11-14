#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Build metadata on the host, never run a cross-compiled generator.
cargo build --locked --lib
case "$(uname -s)" in
  Linux) library=target/debug/libopenclaw_iroh_ffi.so ;;
  Darwin) library=target/debug/libopenclaw_iroh_ffi.dylib ;;
  *) echo 'Binding generation requires Linux or macOS' >&2; exit 1 ;;
esac
cargo run --locked --features bindgen --bin uniffi-bindgen -- generate \
  --library "$library" --language swift --language kotlin --out-dir generated --no-format
# Normalize the generator's trailing whitespace without requiring platform-specific formatters.
python3 - <<'PY'
from pathlib import Path
for path in Path('generated').rglob('*'):
    if path.is_file():
        text = '\n'.join(line.rstrip() for line in path.read_text().splitlines())
        path.write_text(text.rstrip() + '\n')
PY
