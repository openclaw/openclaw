#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="${1:?Usage: stage-mac-runtime.sh <destination> <architecture>}"
shift
[[ "$#" -eq 1 ]] || { echo "ERROR: Standalone Mac packaging requires one architecture; build separate per-architecture artifacts." >&2; exit 1; }
ARCH="$1"
case "$ARCH" in arm64|x86_64) ;; *) echo "ERROR: Unsupported Mac runtime architecture: $ARCH" >&2; exit 1 ;; esac
MODE="${OPENCLAW_MAC_RUNTIME_MODE:-jit}"
case "$MODE" in jit|bytecode) ;; *) echo "ERROR: OPENCLAW_MAC_RUNTIME_MODE must be jit or bytecode" >&2; exit 1 ;; esac
[[ ! -e "$DESTINATION" && ! -L "$DESTINATION" ]] || { echo "ERROR: Runtime destination exists: $DESTINATION" >&2; exit 1; }
mkdir -p "$(dirname "$DESTINATION")"
STAGE="$(cd "$(dirname "$DESTINATION")" && mktemp -d "$PWD/.openclaw-mac-runtime.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
PLUGIN_IDS="$(node --import "$ROOT_DIR/scripts/tsx.mjs" "$ROOT_DIR/scripts/lib/desktop-runtime-plugins.mjs" standalone-ids "$ROOT_DIR")"
INPUT="${OPENCLAW_MAC_RUNTIME_PREBUILT:-}"
if [[ -z "$INPUT" ]]; then
  # The compiler is build tooling only; it never enters the app bundle.
  /bin/bash "$ROOT_DIR/scripts/stage-openclaw-bun.sh" "$STAGE/compiler" darwin "${ARCH/x86_64/x64}"
  BUILD_ARGS=(--plugins "$PLUGIN_IDS")
  [[ "$MODE" != bytecode ]] || BUILD_ARGS+=(--bytecode)
  /usr/bin/arch -"$ARCH" "$STAGE/compiler/bin/bun" "$ROOT_DIR/scripts/build-bun-standalone.mjs" \
    "$STAGE/output" ${BUILD_ARGS+"${BUILD_ARGS[@]}"}
  INPUT="$STAGE/output"
fi
node "$ROOT_DIR/scripts/lib/mac-standalone-runtime.mjs" verify "$INPUT" "$ROOT_DIR/dist/build-info.json" "$MODE" "$ARCH" "$PLUGIN_IDS"
# Preserve the loose sidecar and APFS clone behavior; extraction loses on first launch.
mkdir "$STAGE/runtime"
cp -cR "$INPUT/openclaw" "$INPUT/runtime" "$INPUT/manifest.json" "$STAGE/runtime/"
node "$ROOT_DIR/scripts/lib/mac-standalone-runtime.mjs" stage "$STAGE/runtime"
mv "$STAGE/runtime" "$DESTINATION"
