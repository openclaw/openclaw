#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to NDK 28.2.13676358}"
# NDK r28 defaults to flexible page sizes; retain an explicit ELF alignment contract.
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384"
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 -p 31 \
  -o dist/android/jniLibs build --locked --release --lib
python3 - "$ANDROID_NDK_HOME" <<'PY'
import glob, hashlib, os, subprocess, sys
readelf = glob.glob(sys.argv[1] + '/toolchains/llvm/prebuilt/*/bin/llvm-readelf')[0]
for library in sorted(glob.glob('dist/android/jniLibs/*/*.so')):
    headers = subprocess.check_output([readelf, '-lW', library], text=True)
    loads = [line.split() for line in headers.splitlines() if line.strip().startswith('LOAD ')]
    if not loads or any(int(parts[-1], 16) < 16384 for parts in loads):
        raise SystemExit('Invalid 16 KiB ELF alignment: ' + library)
    with open(library, 'rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    print(f'{library}: {os.path.getsize(library)} bytes sha256={digest}; LOAD alignment >=16KiB')
PY
