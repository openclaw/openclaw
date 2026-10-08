#!/bin/bash
# Bash 5.3 on Darwin can block while constructing a heredoc pipe.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIN="$ROOT_DIR/scripts/lib/openclaw-bun.json"
DESTINATION="${1:-}"
PLATFORM="${2:-}"
[[ "$#" -ge 3 && -n "$DESTINATION" ]] || { echo "Usage: $0 <runtime> <darwin|linux|windows> <arm64|x64> [...] [--unsigned-windows-artifact <directory>]" >&2; exit 2; }
shift 2
case "$PLATFORM" in darwin|linux|windows) ;; *) echo "ERROR: Unsupported Bun platform: $PLATFORM" >&2; exit 2 ;; esac
ARCHES=()
UNSIGNED_WINDOWS_ARTIFACT=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    arm64|x64) ARCHES+=("$1"); shift ;;
    --unsigned-windows-artifact)
      [[ "$PLATFORM" == windows && "$#" -eq 2 && -d "$2" ]] || { echo "ERROR: Unsigned proof needs a local Windows release directory" >&2; exit 2; }
      UNSIGNED_WINDOWS_ARTIFACT="$(cd "$2" && pwd)"
      shift 2 ;;
    *) echo "ERROR: Unsupported Bun architecture or option: $1" >&2; exit 2 ;;
  esac
done
[[ "${#ARCHES[@]}" -gt 0 && ( "$PLATFORM" == darwin || "${#ARCHES[@]}" -eq 1 ) ]] || { echo "ERROR: Bun staging needs one architecture outside Darwin" >&2; exit 2; }
set -- "${ARCHES[@]}"
BUN_NAME=bun
[[ "$PLATFORM" != windows ]] || BUN_NAME=bun.exe
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# Reject an unadmitted Windows pin before contacting prospective release URLs.
TAG="$(node - "$PIN" "$PLATFORM" "$UNSIGNED_WINDOWS_ARTIFACT" "$@" <<'JS'
const assert = require('node:assert/strict');
const [pinPath, platform, unsignedDirectory, ...arches] = process.argv.slice(2);
const pin = require(pinPath);
for (const arch of arches) {
  const artifact = pin.artifacts[`${platform}-${arch}`];
  assert(artifact, `Missing pinned Bun target: ${platform}-${arch}`);
  if (platform === 'windows') {
    assert(unsignedDirectory || artifact.authenticodeSigned === true, 'Windows Bun needs an Authenticode-signed release; unsigned artifacts are test-only');
    assert(typeof artifact.tag === 'string' && /^[a-zA-Z0-9._-]+$/.test(artifact.tag), 'Missing Windows Bun release identity');
    assert(/^[a-f0-9]{40}$/i.test(artifact.commit), 'Missing Windows Bun commit');
  }
}
console.log(platform === 'windows' ? pin.artifacts[`${platform}-${arches[0]}`].tag : pin.tag);
JS
)"
CACHE_DIR="$ROOT_DIR/.cache/openclaw-bun/$TAG"
[[ -z "$UNSIGNED_WINDOWS_ARTIFACT" ]] || CACHE_DIR="$WORK/cache"
mkdir -p "$CACHE_DIR"
sha256() {
  node -e 'const fs = require("node:fs"); console.log(require("node:crypto").createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}
download() {
  if [[ -n "$UNSIGNED_WINDOWS_ARTIFACT" ]]; then
    cp "$UNSIGNED_WINDOWS_ARTIFACT/$1" "$WORK/$1"
    return
  fi
  curl --fail --location --proto '=https' --proto-redir '=https' --no-progress-meter --show-error \
    --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 \
    --output "$WORK/$1" "https://github.com/openclaw/bun/releases/download/$TAG/$1"
}
download SHA256SUMS
download manifest.json
# The release metadata and independent source pin must agree before any payload runs.
node - "$PIN" "$WORK" "$PLATFORM" "$@" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const [pinPath, work, platform, ...arches] = process.argv.slice(2);
const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
const sums = fs.readFileSync(`${work}/SHA256SUMS`, 'utf8').trim().split('\n');
function checksum(name) {
  const matches = sums.map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === name);
  assert.equal(matches.length, 1, `Missing or duplicate release checksum: ${name}`);
  return matches[0][0];
}
const bytes = fs.readFileSync(`${work}/manifest.json`);
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), checksum('manifest.json'), 'Bun manifest sha256 mismatch');
const manifest = JSON.parse(bytes);
assert.equal(manifest.repository, 'openclaw/bun', 'Bun release repository mismatch');
for (const arch of arches) {
  const target = `${platform}-${arch}`;
  const artifact = pin.artifacts[target];
  assert(artifact, `Missing pinned Bun target: ${target}`);
  const identity = platform === 'windows' ? artifact : pin;
  assert.equal(manifest.tag, identity.tag, 'Bun release tag mismatch');
  assert.equal(manifest.bun.commit, identity.commit, 'Bun release commit mismatch');
  assert.equal(manifest.bun.revision, identity.revision, 'Bun release revision mismatch');
  const matches = manifest.assets.filter(asset => asset.target === target);
  assert.equal(matches.length, 1, `Missing or duplicate Bun release target: ${target}`);
  const published = matches[0];
  const {asset, sha256, executable, executableSha256} = artifact;
  assert.deepEqual({asset: published.name, sha256: published.sha256, executable: published.executable.path, executableSha256: published.executable.sha256}, platform === 'windows' ? {asset, sha256, executable, executableSha256} : artifact, 'Bun release artifact differs from pin');
  if (platform === 'windows') {
    assert.equal(published.executable.authenticodeSigned ?? false, artifact.authenticodeSigned, 'Bun release Authenticode admission differs from pin');
  }
  assert.equal(checksum(artifact.asset), artifact.sha256, 'Bun release archive sha256 mismatch');
}
JS
INPUTS=()
for arch in "$@"; do
  read -r COMMIT REVISION ASSET ARCHIVE_SHA EXECUTABLE EXECUTABLE_SHA < <(node - "$PIN" "$PLATFORM-$arch" <<'JS'
const pin = require(process.argv[2]);
const artifact = pin.artifacts[process.argv[3]];
const identity = process.argv[3].startsWith('windows-') ? artifact : pin;
console.log(identity.commit, identity.revision || '-', artifact.asset, artifact.sha256, artifact.executable, artifact.executableSha256);
JS
)
  mkdir -p "$WORK/$arch"
  actual=""
  if [[ -f "$CACHE_DIR/$ASSET" && ! -L "$CACHE_DIR/$ASSET" ]]; then
    actual="$(sha256 "$CACHE_DIR/$ASSET")"
  fi
  if [[ "$actual" != "$ARCHIVE_SHA" ]]; then
    download "$ASSET"
    [[ "$(sha256 "$WORK/$ASSET")" == "$ARCHIVE_SHA" ]] || {
      echo "ERROR: Bun $ASSET sha256 mismatch" >&2; exit 1;
    }
    mv -f "$WORK/$ASSET" "$CACHE_DIR/$ASSET"
  fi
  # Extract the pinned executable's bytes only, never paths supplied by the zip.
  unzip -p "$CACHE_DIR/$ASSET" "$EXECUTABLE" > "$WORK/$arch/$BUN_NAME"
  [[ "$(sha256 "$WORK/$arch/$BUN_NAME")" == "$EXECUTABLE_SHA" ]] || {
    echo "ERROR: Bun executable checksum mismatch" >&2; exit 1;
  }
  chmod 0755 "$WORK/$arch/$BUN_NAME"
  EXECUTOR=()
  if [[ "$PLATFORM" == darwin ]]; then
    native_arch="${arch/x64/x86_64}"
    [[ "$(/usr/bin/lipo -archs "$WORK/$arch/$BUN_NAME")" == "$native_arch" ]] || {
      echo "ERROR: Bun executable architecture mismatch" >&2; exit 1;
    }
    EXECUTOR=(/usr/bin/arch -"$native_arch")
  else
    node - "$WORK/$arch/$BUN_NAME" "$arch" "$PLATFORM" <<'JS'
const assert = require('node:assert/strict');
const bytes = require('node:fs').readFileSync(process.argv[2]);
if (process.argv[4] === 'windows') {
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
  assert(bytes.subarray(0, 2).equals(Buffer.from('MZ')) && offset + 26 <= bytes.length &&
    bytes.subarray(offset, offset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])) &&
    bytes.readUInt16LE(offset + 4) === (process.argv[3] === 'arm64' ? 0xaa64 : 0x8664) &&
    bytes.readUInt16LE(offset + 24) === 0x20b, 'Bun executable architecture mismatch');
} else {
  assert(bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) && bytes.readUInt16LE(18) === (process.argv[3] === 'arm64' ? 183 : 62), 'Bun executable architecture mismatch');
}
JS
  fi
  if [[ "$PLATFORM-$arch" == "$(node -p '`${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`')" ]] ||
     { [[ "$PLATFORM" == darwin ]] && "${EXECUTOR[@]}" /usr/bin/true 2>/dev/null; }; then
    [[ ( ( "$PLATFORM" == windows && "$REVISION" == - ) || "$("${EXECUTOR[@]}" "$WORK/$arch/$BUN_NAME" --revision)" == "$REVISION" ) &&
       "$("${EXECUTOR[@]}" "$WORK/$arch/$BUN_NAME" -p 'Bun.revision')" == "$COMMIT" ]] || {
      echo "ERROR: Bun fork revision mismatch" >&2; exit 1;
    }
  else
    echo "WARN: Bun $PLATFORM-$arch execution skipped; verify on a matching host (or Rosetta for Darwin x64)" >&2
  fi
  INPUTS+=("$WORK/$arch/$BUN_NAME")
done
mkdir -p "$DESTINATION/bin"
if [[ "${#INPUTS[@]}" -gt 1 ]]; then
  /usr/bin/lipo -create "${INPUTS[@]}" -output "$DESTINATION/bin/$BUN_NAME"
else
  cp "${INPUTS[0]}" "$DESTINATION/bin/$BUN_NAME"
fi
chmod 0755 "$DESTINATION/bin/$BUN_NAME"
cp "$PIN" "$DESTINATION/bun-manifest.json"
echo "Staged OpenClaw Bun $TAG [$PLATFORM ${*}]"
