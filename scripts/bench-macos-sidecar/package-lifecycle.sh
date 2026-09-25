#!/bin/bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PROOF_ROOT="${RFC54_BENCH_ROOT:?Set RFC54_BENCH_ROOT to the fresh probe output directory}"
CANDIDATE_APP="${1:?Pass the packaged candidate app bundle}"
INSTALL_ROOT="$PROOF_ROOT/package-lifecycle"
INSTALLED_APP="$INSTALL_ROOT/Applications/OpenClaw.app"
PACKAGES="$INSTALL_ROOT/packages"
BASELINE_APP="$PACKAGES/baseline/OpenClaw.app"
INCOMPATIBLE_APP="$PACKAGES/incompatible/OpenClaw.app"

case "$PROOF_ROOT" in
  /tmp/* | /private/tmp/* | "${RUNNER_TEMP:-/__unset__}"/*) ;;
  *) echo "ERROR: RFC54_BENCH_ROOT must be under /tmp or RUNNER_TEMP" >&2; exit 1 ;;
esac
[[ -d "$CANDIDATE_APP" && ! -L "$CANDIDATE_APP" ]] || {
  echo "ERROR: candidate app bundle is missing or is a symlink: $CANDIDATE_APP" >&2
  exit 1
}

source "$ROOT_DIR/scripts/lib/mac-app-bundle.sh"
mkdir -p "$INSTALL_ROOT/Applications" "$PACKAGES/baseline" "$PACKAGES/incompatible"
/usr/bin/ditto --noqtn "$CANDIDATE_APP" "$BASELINE_APP"
/usr/bin/ditto --noqtn "$CANDIDATE_APP" "$INCOMPATIBLE_APP"

BASELINE_HELPER="$BASELINE_APP/Contents/MacOS/openclaw-mac-node-sidecar"
rm -f "$BASELINE_HELPER"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.0.0" "$BASELINE_APP/Contents/Info.plist"
SIGN_IDENTITY=- ALLOW_ADHOC_SIGNING=1 CODESIGN_TIMESTAMP=off SKIP_TEAM_ID_CHECK=1 \
  "$ROOT_DIR/scripts/codesign-mac-app.sh" "$BASELINE_APP"

INCOMPATIBLE_HELPER="$INCOMPATIBLE_APP/Contents/MacOS/openclaw-mac-node-sidecar"
INCOMPATIBLE_SOURCE="$INSTALL_ROOT/incompatible-helper.c"
cat > "$INCOMPATIBLE_SOURCE" <<'EOF'
#include <unistd.h>

int main(void) {
  unsigned char bootstrap[56];
  if (read(STDIN_FILENO, bootstrap, sizeof(bootstrap)) <= 0) {
    return 1;
  }
  const unsigned char wrong_protocol[] = {0, 0, 0, 1, 0};
  return write(STDOUT_FILENO, wrong_protocol, sizeof(wrong_protocol)) ==
             sizeof(wrong_protocol)
           ? 0
           : 1;
}
EOF
xcrun clang -Os "$INCOMPATIBLE_SOURCE" -o "$INCOMPATIBLE_HELPER"
file "$INCOMPATIBLE_HELPER" | grep -q 'Mach-O'
SIGN_IDENTITY=- ALLOW_ADHOC_SIGNING=1 CODESIGN_TIMESTAMP=off SKIP_TEAM_ID_CHECK=1 \
  "$ROOT_DIR/scripts/codesign-mac-app.sh" "$INCOMPATIBLE_APP"

install_bundle() {
  local source_app="$1"
  local stage
  stage="$(mktemp -d "$INSTALL_ROOT/stage.XXXXXX")/OpenClaw.app"
  /usr/bin/ditto --noqtn "$source_app" "$stage"
  replace_mac_app_bundle "$stage" "$INSTALLED_APP"
  codesign --verify --deep --strict "$INSTALLED_APP"
}

prepare_bundled_probe() {
  local label="$1"
  local source_app="$2"
  PROBE_APP="$INSTALL_ROOT/$label-probe/OpenClaw.app"
  PROBE_EXECUTABLE="$PROBE_APP/Contents/MacOS/OpenClaw"
  mkdir -p "$(dirname "$PROBE_APP")"
  /usr/bin/ditto --noqtn "$source_app" "$PROBE_APP"
  cp "$PROOF_ROOT/bin/functional-probe" "$PROBE_EXECUTABLE"
  chmod 0755 "$PROBE_EXECUTABLE"
  SIGN_IDENTITY=- ALLOW_ADHOC_SIGNING=1 CODESIGN_TIMESTAMP=off SKIP_TEAM_ID_CHECK=1 \
    "$ROOT_DIR/scripts/codesign-mac-app.sh" "$PROBE_APP"
}

expect_bundled_helper_failure() {
  local label="$1"
  local source_app="$2"
  local expected="$3"
  prepare_bundled_probe "$label" "$source_app"
  local helper="$PROBE_APP/Contents/MacOS/openclaw-mac-node-sidecar"
  case "$expected" in
    missing) [[ ! -e "$helper" ]] || { echo "ERROR: missing-helper fixture exists" >&2; exit 1; } ;;
    incompatible)
      [[ -x "$helper" ]] || { echo "ERROR: incompatible-helper fixture is not executable" >&2; exit 1; }
      file "$helper" | grep -q 'Mach-O'
      codesign --verify --strict "$helper"
      [[ "$(shasum -a 256 "$helper" | awk '{print $1}')" != "$CANDIDATE_HELPER_SHA256" ]] || {
        echo "ERROR: incompatible-helper fixture matches the candidate" >&2
        exit 1
      }
      ;;
    signature)
      [[ -x "$helper" ]] || { echo "ERROR: signature fixture helper is not executable" >&2; exit 1; }
      printf '\0' >> "$helper"
      if codesign --verify --deep --strict "$PROBE_APP" 2>/dev/null; then
        echo "ERROR: tampered helper retained a valid bundle signature" >&2
        exit 1
      fi
      ;;
    *) echo "ERROR: unknown helper rejection expectation: $expected" >&2; exit 1 ;;
  esac
  OPENCLAW_BENCH_REPO="$ROOT_DIR" RFC54_EXPECT_STARTUP_REJECTION="$expected" \
    RFC54_FUNCTIONAL_PROBE="$PROBE_EXECUTABLE" \
    node "$ROOT_DIR/scripts/bench-macos-sidecar/functional-smoke.cjs" bundled "$label"
}

verify_candidate() {
  local label="$1"
  local helper="$INSTALLED_APP/Contents/MacOS/openclaw-mac-node-sidecar"
  [[ -x "$helper" ]] || { echo "ERROR: installed helper is missing" >&2; exit 1; }
  codesign --verify --strict "$helper"
  OPENCLAW_BENCH_REPO="$ROOT_DIR" RFC54_CHECK_RETIREMENT=helper \
    node "$ROOT_DIR/scripts/bench-macos-sidecar/functional-smoke.cjs" "$helper" "$label"
}

verify_bundled_signature_gate() {
  prepare_bundled_probe bundled "$INSTALLED_APP"
  codesign --verify --deep --strict "$PROBE_APP"
  OPENCLAW_BENCH_REPO="$ROOT_DIR" RFC54_FUNCTIONAL_PROBE="$PROBE_EXECUTABLE" \
    node "$ROOT_DIR/scripts/bench-macos-sidecar/functional-smoke.cjs" bundled package-bundled-signature
}

# Place the exact packaged candidate into a fresh disposable Applications root.
install_bundle "$CANDIDATE_APP"
verify_candidate package-fresh-install
CANDIDATE_HELPER_SHA256="$(shasum -a 256 "$INSTALLED_APP/Contents/MacOS/openclaw-mac-node-sidecar" | awk '{print $1}')"
verify_bundled_signature_gate
expect_bundled_helper_failure package-tampered-signature "$INSTALLED_APP" signature

# Replace the candidate with a valid predecessor-shaped bundle that omits the helper.
install_bundle "$BASELINE_APP"
[[ ! -e "$INSTALLED_APP/Contents/MacOS/openclaw-mac-node-sidecar" ]] || {
  echo "ERROR: rollback retained the candidate helper" >&2
  exit 1
}
expect_bundled_helper_failure package-replacement-missing-helper "$INSTALLED_APP" missing

# Replacing that bundle with the candidate restores the signed helper and behavior.
install_bundle "$CANDIDATE_APP"
verify_candidate package-replacement-upgrade
[[ "$(shasum -a 256 "$INSTALLED_APP/Contents/MacOS/openclaw-mac-node-sidecar" | awk '{print $1}')" == \
  "$CANDIDATE_HELPER_SHA256" ]] || {
  echo "ERROR: upgraded helper digest differs from the packaged candidate" >&2
  exit 1
}

# A signed but protocol-incompatible executable must fail before any native effect.
install_bundle "$INCOMPATIBLE_APP"
expect_bundled_helper_failure package-incompatible-helper "$INSTALLED_APP" incompatible

# Leave the proof installation on the verified candidate after replacement recovery.
install_bundle "$CANDIDATE_APP"
verify_candidate package-replacement-recovery

HEAD_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
cat > "$PROOF_ROOT/package-lifecycle.json" <<EOF
{
  "head": "$HEAD_SHA",
  "signing": "ad-hoc bundle integrity only; Developer ID and notarization not exercised",
  "helperSha256": "$CANDIDATE_HELPER_SHA256",
  "freshBundlePlacement": true,
  "bundleReplacementUpgrade": true,
  "bundleReplacementRollback": true,
  "missingHelperRejected": true,
  "incompatibleHelperRejected": true,
  "bundledSignatureAccepted": true,
  "tamperedBundledSignatureRejected": true,
  "retirementBeforeNativeEffect": true
}
EOF
cat "$PROOF_ROOT/package-lifecycle.json"
