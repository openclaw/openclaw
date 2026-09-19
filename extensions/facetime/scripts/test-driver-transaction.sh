#!/bin/sh
set -eu

root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/openclaw-driver-transaction-test.XXXXXX")
cleanup() {
  /bin/rm -rf "$root"
}
trap cleanup EXIT

target="$root/OpenClawBridge.driver"
stage="$root/stage.driver"
/bin/mkdir -p "$target" "$stage"
/usr/bin/touch "$target/previous"
if /bin/sh "$(dirname "$0")/commit-driver-transaction.sh" \
  "$stage" "$target" /usr/bin/false; then
  echo "invalid staged driver unexpectedly committed" >&2
  exit 1
fi
test -f "$target/previous"
test ! -e "$stage"

/bin/mkdir -p "$stage"
/bin/mkdir -m 700 -p "$stage/Contents/MacOS"
/usr/bin/touch "$stage/Contents/Info.plist"
/usr/bin/touch "$stage/Contents/MacOS/BlackHole"
/bin/chmod 600 "$stage/Contents/Info.plist"
/bin/chmod 700 "$stage/Contents/MacOS/BlackHole"
/bin/sh "$(dirname "$0")/commit-driver-transaction.sh" \
  "$stage" "$target" /usr/bin/true
test "$(/usr/bin/stat -f '%Lp' "$target")" = "755"
test "$(/usr/bin/stat -f '%Lp' "$target/Contents")" = "755"
test "$(/usr/bin/stat -f '%Lp' "$target/Contents/Info.plist")" = "644"
test "$(/usr/bin/stat -f '%Lp' "$target/Contents/MacOS/BlackHole")" = "755"
test ! -e "$target/previous"

# The privileged entrypoint must have no caller-artifact authority. The
# transaction checks above covered rollback but could not catch that trust leak.
untrusted_driver="$root/untrusted.driver"
untrusted_digest="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
if /bin/sh "$(dirname "$0")/install-driver-root.sh" \
  --install "$untrusted_driver" "$untrusted_digest" >"$root/artifact-contract.log" 2>&1; then
  echo "privileged installer accepted a caller-supplied driver contract" >&2
  exit 1
else
  result=$?
fi
if test "$result" -ne 2; then
  echo "privileged installer still parsed the caller-supplied driver contract" >&2
  exit 1
fi
