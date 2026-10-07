#!/usr/bin/env bash
# Bash 5.3 on Darwin can block while constructing a heredoc pipe.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

# Run only in an ephemeral, non-container Linux acceptance job, after npm install.
# The shell owns the fixture: short-lived probes exit before the installed Doctor runs.
fail() { echo "Native retained-runtime cleanup: $*" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$EUID" -ne 0 ]] || fail "requires a non-root Linux host"
[[ $# -eq 1 ]] || fail "usage: $0 <installed-npm-prefix>"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${EXPECTED_PACKAGE_SOURCE_SHA:?expected source SHA is required}"
: "${EXPECTED_PACKAGE_VERSION:?expected package version is required}"
prefix="$(realpath "$1")"
package_root="$prefix/lib/node_modules/openclaw"
cli="$prefix/bin/openclaw"
[[ -x "$cli" ]] || fail "installed CLI is missing"

assert_host() {
  python3 - <<'PY'
import errno, os, pathlib, re

def require(condition, reason):
    if not condition:
        raise SystemExit("Native cleanup prerequisite failed: " + reason)

require(os.getuid() != 0, "inspector must be non-root")
require(not (os.environ.get("FLY_MACHINE_ID") and os.environ.get("FLY_APP_NAME")), "container environment")
require(not any(pathlib.Path(p).exists() for p in ("/.dockerenv", "/run/.containerenv", "/var/run/.containerenv")), "container sentinel")
cgroup = pathlib.Path("/proc/1/cgroup").read_text()
require(not re.search(r"/docker/|cri-containerd-[0-9a-f]|containerd/[0-9a-f]{64}|/kubepods[/.]|\blxc\b", cgroup), "container cgroup")
status = pathlib.Path("/proc/1/status").read_text()
uids = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", status, re.M)
require(uids is not None and all(int(v) == 0 for v in uids.groups()), "PID 1 must have foreign UID 0")
argv = pathlib.Path("/proc/1/cmdline").read_bytes().split(b"\0")
require(bool(argv[0]) and os.path.basename(argv[0]) in (b"systemd", b"init"), "PID 1 must expose non-runtime init argv")
require(not any(b"openclaw" in arg.lower() for arg in argv), "PID 1 has OpenClaw markers")
try:
    os.readlink("/proc/1/cwd")
except OSError as error:
    require(error.errno in (errno.EACCES, errno.EPERM), "PID 1 cwd must fail with permission denied")
else:
    require(False, "PID 1 cwd is readable; required permission boundary is absent")
print("native-cleanup prerequisite: non-container, inspector_uid=" + str(os.getuid()) + ", pid=1, uid=0, argv=init, cwd=permission-denied")
PY
}
assert_host
python3 - "$package_root" <<'PY'
import json, os, pathlib, re, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
package = json.loads((root / "package.json").read_text())
build = json.loads((root / "dist/build-info.json").read_text())
expected = os.environ["EXPECTED_PACKAGE_SOURCE_SHA"]
if not re.fullmatch(r"[0-9a-f]{40}", expected) or build.get("commit") != expected:
    raise SystemExit("Installed candidate source SHA mismatch")
if package.get("name") != "openclaw" or package.get("version") != os.environ["EXPECTED_PACKAGE_VERSION"]:
    raise SystemExit("Installed candidate package identity mismatch")
print("native-cleanup candidate: " + expected + " version=" + package["version"])
PY

fixture="$(mktemp -d "$RUNNER_TEMP/retained-runtime-native-XXXXXX")"
holder_pid=""
holder_birth=""
process_birth() {
  python3 - "$1" <<'PY'
import os, pathlib, sys
try:
    root = pathlib.Path("/proc") / sys.argv[1]
    if root.stat().st_uid != os.getuid():
        raise ValueError("holder UID changed")
    fields = (root / "stat").read_text().rsplit(") ", 1)[1].split()
    print(pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":" + fields[19])
except (OSError, ValueError, IndexError):
    sys.exit(1)
PY
}
cleanup() {
  local result=$?
  # Only this shell's child, with the same observed Linux process birth, may be signalled.
  if [[ -n "$holder_pid" && -n "$holder_birth" ]] &&
    [[ "$(process_birth "$holder_pid" || true)" == "$holder_birth" ]]; then
    kill -TERM "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  exec 3>&- 4>&-
  if [[ "$result" -ne 0 ]]; then
    python3 - "$fixture" "$prefix" <<'PY'
import pathlib, sys
for name in ("retained.log", "removed.log"):
    log = pathlib.Path(sys.argv[1]) / name
    if log.exists():
        text = log.read_text(errors="replace")[-4096:]
        print(name + ":\n" + text.replace(sys.argv[1], "<fixture>").replace(sys.argv[2], "<installed-prefix>"))
PY
  fi
  rm -rf -- "$fixture"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$fixture/home" "$fixture/state" "$fixture/tmp" "$fixture/config" "$fixture/cache" "$fixture/data" "$fixture/runtime"
chmod 700 "$fixture" "$fixture/state" "$fixture/runtime"
cd "$fixture"
artifact="$(mktemp -d "$fixture/tmp/openclaw-update-runtime-XXXXXX")"
projected="$artifact/tree/2f/${package_root#/}"
mkdir -p "$projected"
cp "$package_root/package.json" "$projected/package.json"
printf 'unrelated sentinel\n' > "$fixture/tmp/keep.txt"
python3 - "$fixture/state/openclaw.json" <<'PY'
import json, pathlib, socket, sys
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
pathlib.Path(sys.argv[1]).write_text(json.dumps({"gateway": {"mode": "local", "port": port}}))
PY

# EOF settles the one owned runtime holder. The readiness pipe proves Node has started.
mkfifo "$fixture/holder-input" "$fixture/holder-ready"
exec 3<> "$fixture/holder-input" 4<> "$fixture/holder-ready"
node -e 'process.stdin.resume(); process.stdout.write("ready\n")' "$artifact" \
  < "$fixture/holder-input" >&4 3>&- 4>&- &
holder_pid=$!
holder_birth="$(process_birth "$holder_pid")"
IFS= read -r -t 30 ready <&4 || fail "holder did not become ready"
[[ "$ready" == ready ]] || fail "unexpected holder readiness"

run_doctor() {
  assert_host
  timeout --signal=TERM --kill-after=15s 300s env -i \
    PATH="$PATH" HOME="$fixture/home" TMPDIR="$fixture/tmp" TMP="$fixture/tmp" TEMP="$fixture/tmp" \
    XDG_CONFIG_HOME="$fixture/config" XDG_CACHE_HOME="$fixture/cache" XDG_DATA_HOME="$fixture/data" \
    XDG_RUNTIME_DIR="$fixture/runtime" OPENCLAW_STATE_DIR="$fixture/state" \
    OPENCLAW_CONFIG_PATH="$fixture/state/openclaw.json" CI=1 NO_COLOR=1 COLUMNS=1000 \
    "$cli" doctor --fix --non-interactive > "$1" 2>&1 3>&- 4>&- || fail "installed Doctor failed ($2)"
}
assert_doctor_message() {
  python3 - "$1" "$artifact" "$2" "${holder_pid:-}" <<'PY'
import pathlib, re, sys
text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", pathlib.Path(sys.argv[1]).read_text())
# Doctor notes wrap lines and add a box; preserve the message, not its terminal layout.
text = " ".join(line.strip(" │┃|") for line in text.splitlines())
if sys.argv[3] == "retain":
    if "Runtime retained at " + sys.argv[2] not in text or not any(
        sys.argv[4] in [pid.strip() for pid in group.split(",")]
        for group in re.findall(r"other OpenClaw processes are still running \(PIDs: ([\d, ]+)\)", text)
    ):
        raise SystemExit("Doctor did not identify the owned live holder")
elif "Removed abandoned updater runtime: " + sys.argv[2] not in text:
    raise SystemExit("Doctor did not report runtime removal")
PY
}
run_doctor "$fixture/retained.log" retain
[[ -d "$artifact" ]] || fail "Doctor removed a live holder's runtime"
[[ "$(process_birth "$holder_pid")" == "$holder_birth" ]] || fail "holder exited before retention proof"
assert_doctor_message "$fixture/retained.log" retain
echo "native-cleanup retained: live owned holder pid=$holder_pid birth=$holder_birth"
exec 3>&-
wait "$holder_pid" || fail "owned holder did not settle successfully"
[[ "$(process_birth "$holder_pid" || true)" != "$holder_birth" ]] || fail "settled holder still exists"
holder_pid=""
run_doctor "$fixture/removed.log" remove
assert_doctor_message "$fixture/removed.log" remove
[[ ! -e "$artifact" && ! -L "$artifact" ]] || fail "abandoned runtime remains"
[[ "$(cat "$fixture/tmp/keep.txt")" == 'unrelated sentinel' ]] || fail "unrelated sentinel changed"
echo "native-cleanup passed: holder settled, removal reported, runtime absent, unrelated sentinel preserved"
