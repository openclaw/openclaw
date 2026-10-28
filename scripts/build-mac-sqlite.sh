#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/scripts/lib/sqlite-macos.json"
ARCH="${1:-}"
DESTINATION="${2:-}"
DEPLOYMENT_TARGET="${OPENCLAW_MACOS_DEPLOYMENT_TARGET:-15.0}"
[[ "$DEPLOYMENT_TARGET" =~ ^[0-9]+\.[0-9]+$ ]] || {
  echo "ERROR: Invalid SQLite macOS deployment target" >&2; exit 2;
}
if [[ "$#" != 2 || ( "$ARCH" != arm64 && "$ARCH" != x86_64 && "$ARCH" != universal ) || -z "$DESTINATION" || "$DESTINATION" == -* ]]; then
  echo "Usage: scripts/build-mac-sqlite.sh <arm64|x86_64|universal> <runtime-directory>" >&2
  exit 2
fi
read -r VERSION URL ARCHIVE_SHA < <(node - "$MANIFEST" <<'JS'
const manifest = require(process.argv[2]);
console.log(manifest.version, manifest.url, manifest.sha256);
JS
)
CACHE_DIR="$ROOT_DIR/apps/macos/.build/sqlite/$VERSION"
ARCHIVE="${URL##*/}"
SOURCE_DIR="${ARCHIVE%.zip}"
mkdir -p "$CACHE_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-sqlite.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

actual=""
if [[ -f "$CACHE_DIR/$ARCHIVE" && ! -L "$CACHE_DIR/$ARCHIVE" ]]; then
  actual="$(shasum -a 256 "$CACHE_DIR/$ARCHIVE" | awk '{print $1}')"
fi
if [[ "$actual" != "$ARCHIVE_SHA" ]]; then
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 --retry 3 --retry-delay 2 \
    --output "$WORK/$ARCHIVE" "$URL"
  if [[ "$(shasum -a 256 "$WORK/$ARCHIVE" | awk '{print $1}')" != "$ARCHIVE_SHA" ]]; then
    echo "ERROR: SQLite $ARCHIVE sha256 mismatch" >&2
    exit 1
  fi
  mv -f "$WORK/$ARCHIVE" "$CACHE_DIR/$ARCHIVE"
fi
# Extract only the compiler input, without trusting archive paths as destinations.
unzip -p "$CACHE_DIR/$ARCHIVE" "$SOURCE_DIR/sqlite3.c" > "$WORK/sqlite3.c"

ARCH_FLAGS=(-arch "$ARCH")
ARCHS=("$ARCH")
if [[ "$ARCH" == universal ]]; then
  ARCHS=(arm64 x86_64)
  ARCH_FLAGS=(-arch arm64 -arch x86_64)
fi
# Match Homebrew's library features, including its session and URI support.
# JSON is built in on this SQLite line; OMIT_LOAD_EXTENSION must remain unset.
xcrun clang -O2 -dynamiclib -fPIC "-mmacosx-version-min=$DEPLOYMENT_TARGET" \
  "${ARCH_FLAGS[@]}" -install_name @loader_path/libsqlite3.dylib \
  -DSQLITE_THREADSAFE=1 \
  -DSQLITE_ENABLE_API_ARMOR=1 \
  -DSQLITE_ENABLE_COLUMN_METADATA=1 \
  -DSQLITE_ENABLE_DBSTAT_VTAB=1 \
  -DSQLITE_ENABLE_FTS3=1 \
  -DSQLITE_ENABLE_FTS3_PARENTHESIS=1 \
  -DSQLITE_ENABLE_FTS5=1 \
  -DSQLITE_ENABLE_GEOPOLY=1 \
  -DSQLITE_ENABLE_JSON1=1 \
  -DSQLITE_ENABLE_MATH_FUNCTIONS=1 \
  -DSQLITE_ENABLE_MEMORY_MANAGEMENT=1 \
  -DSQLITE_ENABLE_PREUPDATE_HOOK=1 \
  -DSQLITE_ENABLE_RTREE=1 \
  -DSQLITE_ENABLE_SESSION=1 \
  -DSQLITE_ENABLE_STAT4=1 \
  -DSQLITE_ENABLE_UNLOCK_NOTIFY=1 \
  -DSQLITE_MAX_VARIABLE_NUMBER=250000 \
  -DSQLITE_USE_URI=1 \
  "$WORK/sqlite3.c" -o "$WORK/libsqlite3.dylib"
for arch in "${ARCHS[@]}"; do
  /usr/bin/lipo "$WORK/libsqlite3.dylib" -verify_arch "$arch"
done
mkdir -p "$DESTINATION/lib"
cp "$WORK/libsqlite3.dylib" "$DESTINATION/lib/libsqlite3.dylib"
chmod 0755 "$DESTINATION/lib/libsqlite3.dylib"
echo "Built SQLite $VERSION ($ARCH)"
