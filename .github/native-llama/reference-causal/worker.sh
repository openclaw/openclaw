#!/bin/bash
set -euo pipefail
packet="$(cd "$(dirname "$0")" && pwd -P)"
[[ "$#" == 2 && -f "$1" && -d "$2" ]]
archive="$1"; output="$(cd "$2" && pwd -P)"
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]]
[[ "${LLAMA_REFERENCE_ACK:-}" == parent-reviewed-reference-only ]]
[[ "$(uname -m)" == arm64 && "$(sw_vers -productVersion)" == 26.6.2 ]]
[[ "${DEVELOPER_DIR:?}" == /Applications/Xcode_26.4.1.app/Contents/Developer ]]
xcodebuild -version > "$output/xcode.txt"
grep -q '^Xcode 26.4.1$' "$output/xcode.txt"
xcrun swift --version > "$output/swift.txt"
grep -Eq 'Swift version 6\.3\.1([. ]|$)' "$output/swift.txt"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
[[ "$(xcrun --sdk macosx --show-sdk-version)" == 26.4 ]]
original_home="$(cd "$HOME" && pwd -P)"
work="$(mktemp -d "$RUNNER_TEMP/llama-reference.XXXXXX")"
printf '%s\n' "$work" > "$output/owned-work-root.txt"
python3 -I -S "$packet/admit_inputs.py" "$archive" "$work/input" > "$output/input-admission.json"
cp -R "$work/input" "$output/admitted-inputs"
mkdir -p "$work/build-home" "$work/build-tmp" "$work/state/home/Library/Preferences" "$work/state/tmp" "$work/state/output"
# SDK-only single-file executable: no SwiftPM, app build, packages, models or Gateway.
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$work/build-home" TMPDIR="$work/build-tmp/" \
  DEVELOPER_DIR="$DEVELOPER_DIR" \
  /usr/bin/xcrun swiftc -parse-as-library -swift-version 6 -j 2 -target arm64-apple-macosx26.2 \
  -sdk "$sdk" -framework AppKit -framework SwiftUI -framework CryptoKit \
  "$packet/ReferenceDiagnostic.swift" "$packet/SourceReferenceProducer.swift" -o "$work/reference-diagnostic" > "$output/compile.log" 2>&1
/usr/bin/shasum -a 256 "$work/reference-diagnostic" > "$output/executable.sha256"
native_code=0
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$work/state/home" CFFIXED_USER_HOME="$work/state/home" \
  TMPDIR="$work/state/tmp/" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 NSUnbufferedIO=YES \
  SWIFT_BACKTRACE=enable=yes,interactive=no,color=no,sanitize=yes \
  /usr/bin/sandbox-exec -D "ORIGINAL_HOME=$original_home" -D "REPO=$work" \
  -D "ISOLATED_ROOT=$work/state" -f "$packet/macos-health-render.sb" \
  "$work/reference-diagnostic" "$work/input" "$work/state/output" > "$output/native.log" 2>&1 || native_code=$?
mkdir "$output/native"
cp -R "$work/state/output/." "$output/native/"
# Original inputs are read-only to the native process and remain byte-identical.
(cd "$work/input" && /usr/bin/shasum -a 256 -c ADMITTED-SHA256SUMS) > "$output/inputs-after.txt"
exit "$native_code"
