#!/usr/bin/env bash
# Linux CI only: temporary trust for a disposable, rooted Android emulator.
set -euo pipefail
[[ "$(uname -s)" == Linux ]]
mode=${1:?prepare or cleanup}
state=${2:?absolute evidence directory}
[[ "$state" == /* ]]
serial=emulator-5554
store=/apex/com.android.conscrypt/cacerts
remote=/data/local/tmp/openclaw-native-tls
adb_task() { adb -s "$serial" "$@"; }
manifest() {
  adb_task shell "$@" sh -c "'cd $store && find . -type f -exec sha256sum {} + | sort'" | tr -d '\r'
}
store_mount_count() {
  local pid=$1 receipt="$state/zygote-$1.$2.mountinfo"
  adb_task shell cat "/proc/$pid/mountinfo" > "$receipt"
  python3 -c 'import sys; print(sum(line.split()[4] == sys.argv[2] for line in open(sys.argv[1])))' "$receipt" "$store"
}

case "$mode" in
  prepare)
    mkdir -p "$state"
    [[ ! -e "$state/baseline.sha256" ]]
    [[ "$(adb_task shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
    adb_task root
    adb_task wait-for-device
    [[ "$(adb_task shell id -u | tr -d '\r')" == 0 ]]
    adb_task shell getprop ro.build.fingerprint > "$state/build-fingerprint.txt"
    adb_task shell getprop ro.build.version.security_patch > "$state/security-patch.txt"
    adb_task shell sha256sum /system/bin/toybox > "$state/toybox.sha256"
    image_metadata="${ANDROID_SDK_ROOT:?}/${SYSTEM_IMAGE//;/\/}/package.xml"
    cp "$image_metadata" "$state/system-image-package.xml"
    adb_task shell getenforce > "$state/selinux.before.txt"
    [[ "$(tr -d '\r' < "$state/selinux.before.txt")" == Enforcing ]]
    manifest > "$state/baseline.sha256"
    [[ "$(wc -l < "$state/baseline.sha256")" -gt 100 ]]
    pids=$(adb_task shell pidof zygote64 zygote | tr -d '\r')
    : > "$state/zygotes.txt"
    : > "$state/namespaces.txt"
    for pid in $pids; do
      [[ "$pid" =~ ^[0-9]+$ ]]
      namespace=$(adb_task shell readlink "/proc/$pid/ns/mnt" | tr -d '\r')
      [[ "$namespace" == mnt:* ]]
      printf '%s %s\n' "$pid" "$namespace" >> "$state/zygote-namespaces.txt"
      # A 32/64-bit zygote pair may share one namespace; mount it only once.
      if ! grep -Fxq "$namespace" "$state/namespaces.txt"; then
        printf '%s\n' "$namespace" >> "$state/namespaces.txt"
        printf '%s\n' "$pid" >> "$state/zygotes.txt"
      fi
    done
    [[ -s "$state/zygotes.txt" ]]
    while read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]]
      manifest nsenter --mount="/proc/$pid/ns/mnt" -- > "$state/zygote-$pid.before.sha256"
      cmp "$state/baseline.sha256" "$state/zygote-$pid.before.sha256"
      # This disposable image must not have a pre-existing mount at the fixture target.
      [[ "$(store_mount_count "$pid" before)" == 0 ]]
      # Write intent before any bind, so cleanup covers a crash before its receipt.
      printf '%s\n' "$pid" >> "$state/eligible-zygotes.txt"
    done < "$state/zygotes.txt"
    # Extract canonical public fixtures rather than maintaining duplicate certificates.
    python3 - "$state" <<'PY'
from pathlib import Path
import re, sys, textwrap
source = Path('apps/android/app/src/testShared/java/ai/openclaw/app/gateway/GatewayTlsTestFixtures.kt').read_text()
for name in ('NATIVE_TEST_ROOT', 'COMPROMISED_ROOT'):
    match = re.search(r'private val ' + name + r'\s*=\s*"""(.*?)"""', source, re.S)
    assert match, name
    (Path(sys.argv[1]) / (name + '.pem')).write_text(textwrap.dedent(match[1]).strip() + '\n')
PY
    adb_task shell "test ! -e $remote && mkdir $remote && cp -a $store/. $remote/"
    for pem in "$state"/*.pem; do
      hash=$(openssl x509 -in "$pem" -noout -subject_hash_old)
      index=0
      while adb_task shell "test -e $remote/$hash.$index"; do index=$((index + 1)); done
      destination="$remote/$hash.$index"
      adb_task push "$pem" "$destination"
      openssl x509 -in "$pem" -noout -subject -fingerprint -sha256 >> "$state/fixture-identities.txt"
    done
    adb_task shell "chown -R root:root $remote && chmod 755 $remote && chmod 644 $remote/* && chcon -R u:object_r:system_file:s0 $remote"
    # New app processes inherit zygote mount namespaces on Android 14+.
    while read -r pid; do
      adb_task shell nsenter --mount="/proc/$pid/ns/mnt" -- mount --bind "$remote" "$store"
      printf '%s\n' "$pid" >> "$state/mounted-zygotes.txt"
      manifest nsenter --mount="/proc/$pid/ns/mnt" -- > "$state/zygote-$pid.fixture.sha256"
      [[ "$(wc -l < "$state/zygote-$pid.fixture.sha256")" -eq "$(($(wc -l < "$state/baseline.sha256") + 2))" ]]
    done < "$state/eligible-zygotes.txt"
    ;;
  cleanup)
    # Stop and uninstall the task app, including DeviceIdentityStore test state.
    adb_task shell am force-stop ai.openclaw.app.debug
    adb_task uninstall ai.openclaw.app.debug.test > "$state/uninstall-test.txt" 2>&1 || true
    adb_task uninstall ai.openclaw.app.debug > "$state/uninstall-app.txt" 2>&1 || true
    adb_task shell pm list packages ai.openclaw.app.debug > "$state/packages.after-uninstall.txt"
    ! grep -Eq '^package:ai\.openclaw\.app\.debug(\.test)?[[:space:]]*$' "$state/packages.after-uninstall.txt"
    # Inspect every pre-recorded namespace, even if interruption occurred between
    # bind and the successful-mount receipt. Parent-namespace equality is insufficient.
    if [[ -f "$state/eligible-zygotes.txt" ]]; then
      while read -r pid; do
        count=$(store_mount_count "$pid" cleanup)
        [[ "$count" == 0 || "$count" == 1 ]]
        if [[ "$count" == 1 ]]; then
          adb_task shell nsenter --mount="/proc/$pid/ns/mnt" -- umount "$store"
        fi
        [[ "$(store_mount_count "$pid" restored)" == 0 ]]
        manifest nsenter --mount="/proc/$pid/ns/mnt" -- > "$state/zygote-$pid.restored.sha256"
        cmp "$state/baseline.sha256" "$state/zygote-$pid.restored.sha256"
      done < "$state/eligible-zygotes.txt"
    fi
    if [[ -f "$state/baseline.sha256" ]]; then
      manifest > "$state/restored.sha256"
      cmp "$state/baseline.sha256" "$state/restored.sha256"
      adb_task shell getenforce > "$state/selinux.restored.txt"
      cmp "$state/selinux.before.txt" "$state/selinux.restored.txt"
      adb_task shell "rm -rf $remote"
      if [[ -s "$state/eligible-zygotes.txt" ]]; then
        printf 'PASS: all fixture-eligible namespace stores and parent baseline restored; task app uninstalled. Emulator must still be disposed.\n' > "$state/CLEANUP.txt"
      else
        printf 'No namespace became fixture-eligible; no bind attempted. Parent baseline unchanged; task app uninstalled. Emulator must still be disposed.\n' > "$state/CLEANUP.txt"
      fi
    else
      printf 'No trust baseline captured; no trust mutation attempted.\n' > "$state/CLEANUP.txt"
    fi
    ;;
  *) exit 2 ;;
esac
