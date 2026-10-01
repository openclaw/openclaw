#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/scripts/lib/openclaw-bun-macos.json"
DESTINATION="${1:-}"
[[ "$#" -ge 2 && -n "$DESTINATION" ]] || { echo "Usage: $0 <runtime> <arm64|x86_64> [...]" >&2; exit 2; }
shift
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
INPUTS=()
for arch in "$@"; do
  case "$arch" in arm64|x86_64) ;; *) echo "ERROR: Unsupported Bun architecture: $arch" >&2; exit 2 ;; esac
  read -r TAG COMMIT REVISION ASSET ARCHIVE_SHA EXECUTABLE EXECUTABLE_SHA < <(node - "$MANIFEST" "$arch" <<'JS'
const pin = require(process.argv[2]);
const artifact = pin.artifacts[process.argv[3]];
console.log(pin.tag, pin.commit, pin.revision, artifact.asset, artifact.sha256, artifact.executable, artifact.executableSha256);
JS
)
  CACHE_DIR="$ROOT_DIR/apps/macos/.build/openclaw-bun/$TAG"
  mkdir -p "$CACHE_DIR" "$WORK/$arch"
  actual=""
  if [[ -f "$CACHE_DIR/$ASSET" && ! -L "$CACHE_DIR/$ASSET" ]]; then
    actual="$(shasum -a 256 "$CACHE_DIR/$ASSET" | awk '{print $1}')"
  fi
  if [[ "$actual" != "$ARCHIVE_SHA" ]]; then
    curl --fail --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 180 --retry 3 --retry-delay 2 \
      --output "$WORK/$ASSET" "https://github.com/openclaw/bun/releases/download/$TAG/$ASSET"
    [[ "$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')" == "$ARCHIVE_SHA" ]] || {
      echo "ERROR: Bun $ASSET sha256 mismatch" >&2; exit 1;
    }
    mv -f "$WORK/$ASSET" "$CACHE_DIR/$ASSET"
  fi
  # Extract the pinned executable's bytes only, never paths supplied by the zip.
  /usr/bin/unzip -p "$CACHE_DIR/$ASSET" "$EXECUTABLE" > "$WORK/$arch/bun"
  [[ "$(shasum -a 256 "$WORK/$arch/bun" | awk '{print $1}')" == "$EXECUTABLE_SHA" &&
     "$(/usr/bin/lipo -archs "$WORK/$arch/bun")" == "$arch" ]] || {
    echo "ERROR: Bun executable checksum or architecture mismatch" >&2; exit 1;
  }
  chmod 0755 "$WORK/$arch/bun"
  if /usr/bin/arch -"$arch" /usr/bin/true 2>/dev/null; then
    [[ "$(/usr/bin/arch -"$arch" "$WORK/$arch/bun" --revision)" == "$REVISION" &&
       "$(/usr/bin/arch -"$arch" "$WORK/$arch/bun" -p 'Bun.revision')" == "$COMMIT" ]] || {
      echo "ERROR: Bun fork revision mismatch" >&2; exit 1;
    }
  else
    echo "WARN: Bun $arch execution skipped; install Rosetta to verify this architecture" >&2
  fi
  INPUTS+=("$WORK/$arch/bun")
done
mkdir -p "$DESTINATION/bin"
if [[ "${#INPUTS[@]}" -gt 1 ]]; then
  /usr/bin/lipo -create "${INPUTS[@]}" -output "$DESTINATION/bin/bun"
else
  cp "${INPUTS[0]}" "$DESTINATION/bin/bun"
fi
chmod 0755 "$DESTINATION/bin/bun"
cp "$MANIFEST" "$DESTINATION/bun-manifest.json"
echo "Staged OpenClaw Bun $TAG [${*}]"
