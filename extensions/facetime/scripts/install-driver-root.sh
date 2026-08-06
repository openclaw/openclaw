#!/bin/sh
set -eu

version="0.7.1"
archive_sha256="e9de179da54ed55ff27876990f3a2dcfefa66e6bd6cfcba448a8564eabdf3e89"
factory_uuid="A11C0A17-6F8E-4D72-9AF4-0A1D10B21D6E"
blackhole_factory_uuid="e395c745-4eea-4d94-bb92-46224221047c"
plugin_type_uuid="443ABAB8-E7B3-491A-B985-BEB9187030DB"
recipe="facetime-paired-v1"
bundle_id="ai.openclaw.BlackHoleBridge"
installed_driver="/Library/Audio/Plug-Ins/HAL/OpenClawBridge.driver"
work_dir=$(/usr/bin/mktemp -d /private/tmp/openclaw-driver-install.XXXXXX)
archive="$work_dir/BlackHole.tar.gz"
source_dir="$work_dir/BlackHole-$version"
build_dir="$work_dir/build"
driver="$build_dir/BlackHole.driver"

remove_tree() {
  target=$1
  if test -x /usr/bin/trash; then
    /usr/bin/trash "$target"
  else
    /usr/bin/python3 -c 'import os, shutil, sys; p=sys.argv[1]; shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else (os.unlink(p) if os.path.lexists(p) else None)' "$target"
  fi
}

cleanup() {
  if test -e "$work_dir"; then
    remove_tree "$work_dir" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
/bin/chmod 700 "$work_dir"

if test -d /Applications/Xcode.app/Contents/Developer; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  export DEVELOPER_DIR
fi

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
  PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" \
  'GCC_PREPROCESSOR_DEFINITIONS=$GCC_PREPROCESSOR_DEFINITIONS kNumber_Of_Channels=2 kPlugIn_BundleID=\"ai.openclaw.BlackHoleBridge\" kDriver_Name=\"OpenClawBridge\" kHas_Driver_Name_Format=false kDevice_Name=\"OpenClaw-Mic\" kDevice2_Name=\"OpenClaw-Feed\" kDevice_IsHidden=false kDevice2_IsHidden=false kDevice_HasInput=true kDevice_HasOutput=false kDevice2_HasInput=false kDevice2_HasOutput=true'

/usr/bin/codesign --force --deep --sign - "$driver"
/usr/libexec/PlistBuddy -c "Add :OpenClawDriverRecipe string $recipe" \
  "$driver/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :OpenClawBlackHoleVersion string $version" \
  "$driver/Contents/Info.plist"
/usr/bin/codesign --force --deep --sign - "$driver"

if /usr/bin/find "$driver" -type l -print -quit | /usr/bin/grep -q .; then
  echo "Built OpenClaw paired audio driver contains a symbolic link." >&2
  exit 1
fi
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$driver/Contents/Info.plist")" = "$bundle_id"
test "$(/usr/libexec/PlistBuddy -c 'Print :OpenClawDriverRecipe' "$driver/Contents/Info.plist")" = "$recipe"
test "$(/usr/libexec/PlistBuddy -c 'Print :OpenClawBlackHoleVersion' "$driver/Contents/Info.plist")" = "$version"
/usr/bin/codesign --verify --strict "$driver"

if test -e "$installed_driver"; then
  remove_tree "$installed_driver"
fi
/bin/mkdir -p /Library/Audio/Plug-Ins/HAL
/usr/bin/ditto "$driver" "$installed_driver"
/usr/sbin/chown -R root:wheel "$installed_driver"
/bin/chmod -R go-w "$installed_driver"
/usr/bin/codesign --verify --strict "$installed_driver"

for pid in $(/usr/bin/pgrep -x coreaudiod || true); do
  /bin/kill -9 "$pid"
done
