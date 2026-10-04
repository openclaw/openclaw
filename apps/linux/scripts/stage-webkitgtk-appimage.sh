#!/usr/bin/env bash
# Stage a locally built WebKitGTK 2.54.1 runtime into an x86_64 Tauri AppDir.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 APPDIR WEBKITGTK_PREFIX" >&2
  exit 2
fi
appdir=$(realpath -- "$1")
prefix=$(realpath -- "$2")
exec_rel=usr/lib/x86_64-linux-gnu/webkit2gtk-4.1
source_exec="$prefix/libexec/webkit2gtk-4.1"
source_bundle="$prefix/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so"
target_exec="$appdir/$exec_rel"

[[ -f "$appdir/AppRun" ]] || { echo "AppRun missing from $appdir" >&2; exit 1; }
[[ -d "$appdir/usr/lib" ]] || { echo "AppDir libraries missing" >&2; exit 1; }
if ! find "$appdir/usr/lib" -name "libwebkit2gtk-4.1.so*" -print -quit | grep -q .; then
  echo "WebKitGTK library missing from AppDir; bundle the matching 2.54.1 library first" >&2
  exit 1
fi
mkdir -p "$target_exec/injected-bundle"
for name in WebKitWebProcess WebKitNetworkProcess WebKitGPUProcess; do
  install -m 0755 "$source_exec/$name" "$target_exec/$name"
done
install -m 0644 "$source_bundle" "$target_exec/injected-bundle/libwebkit2gtkinjectedbundle.so"

python3 - "$appdir/AppRun" "$exec_rel" <<'PY'
from pathlib import Path
import sys
launcher = Path(sys.argv[1])
exec_rel = sys.argv[2]
source = launcher.read_text()
marker = 'exec "$this_dir"/AppRun.wrapped "$@"'
addition = (
    f'export WEBKIT_EXEC_PATH="$this_dir/{exec_rel}"\n'
    f'export WEBKIT_INJECTED_BUNDLE_PATH="$this_dir/{exec_rel}/injected-bundle"\n'
)
if source.count(marker) != 1:
    raise SystemExit("AppRun wrapper marker missing or ambiguous")
if "export WEBKIT_EXEC_PATH=" in source:
    raise SystemExit("AppRun already configures WEBKIT_EXEC_PATH")
launcher.write_text(source.replace(marker, addition + marker))
PY
