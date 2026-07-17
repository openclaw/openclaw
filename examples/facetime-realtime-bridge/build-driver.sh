#!/bin/sh
set -eu

version="0.7.1"
archive_sha256="e9de179da54ed55ff27876990f3a2dcfefa66e6bd6cfcba448a8564eabdf3e89"
factory_uuid="A11C0A17-6F8E-4D72-9AF4-0A1D10B21D6E"
blackhole_factory_uuid="e395c745-4eea-4d94-bb92-46224221047c"
plugin_type_uuid="443ABAB8-E7B3-491A-B985-BEB9187030DB"

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work_dir=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/openclaw-driver.XXXXXX")
archive="$work_dir/BlackHole.tar.gz"
source_dir="$work_dir/BlackHole-$version"
build_dir="$work_dir/build"
output_dir="$here/native-driver/.build"
output_driver="$output_dir/OpenClawBridge.driver"

if test -d /Applications/Xcode.app/Contents/Developer; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  export DEVELOPER_DIR
fi

cleanup() {
  /usr/bin/trash "$work_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

/usr/bin/curl -fsSL \
  "https://github.com/ExistentialAudio/BlackHole/archive/refs/tags/v$version.tar.gz" \
  -o "$archive"
printf '%s  %s\n' "$archive_sha256" "$archive" | /usr/bin/shasum -a 256 -c -
/usr/bin/tar -xzf "$archive" -C "$work_dir"

plist="$source_dir/BlackHole/BlackHole.plist"
/usr/libexec/PlistBuddy -c "Delete :CFPlugInFactories:$blackhole_factory_uuid" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFPlugInFactories:$factory_uuid string BlackHole_Create" "$plist"
/usr/libexec/PlistBuddy -c "Set :CFPlugInTypes:$plugin_type_uuid:0 $factory_uuid" "$plist"

/usr/bin/xcodebuild \
  -quiet \
  -project "$source_dir/BlackHole.xcodeproj" \
  -scheme BlackHole \
  -configuration Release \
  -derivedDataPath "$work_dir/DerivedData" \
  CODE_SIGNING_ALLOWED=NO \
  CONFIGURATION_BUILD_DIR="$build_dir" \
  PRODUCT_BUNDLE_IDENTIFIER=ai.openclaw.BlackHoleBridge \
  'GCC_PREPROCESSOR_DEFINITIONS=$GCC_PREPROCESSOR_DEFINITIONS kNumber_Of_Channels=2 kPlugIn_BundleID=\"ai.openclaw.BlackHoleBridge\" kDriver_Name=\"OpenClawBridge\" kHas_Driver_Name_Format=false kDevice_Name=\"OpenClaw-Mic\" kDevice2_Name=\"OpenClaw-Feed\" kDevice_IsHidden=false kDevice2_IsHidden=false kDevice_HasInput=true kDevice_HasOutput=false kDevice2_HasInput=false kDevice2_HasOutput=true'

/usr/bin/codesign --force --deep --sign - "$build_dir/BlackHole.driver"
/usr/bin/codesign --verify --strict "$build_dir/BlackHole.driver"
/bin/mkdir -p "$output_dir"
if test -e "$output_driver"; then
  /usr/bin/trash "$output_driver"
fi
/usr/bin/ditto "$build_dir/BlackHole.driver" "$output_driver"
printf 'Built %s\n' "$output_driver"
printf 'BlackHole is GPL-3.0. Keep this local build separate from MIT-licensed OpenClaw; do not bundle or commit it.\n'
