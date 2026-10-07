#!/usr/bin/env bash
# Bash 5.3 on Darwin can block while constructing a heredoc pipe.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

# Run only in an ephemeral, non-container Linux acceptance job, after npm install.
# The shell owns the fixture: short-lived probes exit before the installed Doctor runs.
fail() { echo "Native retained-runtime cleanup: $*" >&2; exit 1; }
run_isolated_account() {
  [[ "$(uname -s)" == Linux && "$(id -u)" == 0 && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]] || fail "isolated account requires the hosted Linux administrator"
  grep -Eq '^ID="?ubuntu"?$' /etc/os-release || fail "isolated account requires Ubuntu"
  [[ $# -eq 1 && ${GITHUB_RUN_ID:-} =~ ^[0-9]{1,15}$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]{1,3}$ ]] || fail "invalid isolated run identity"
  [[ ${RUNNER_UID:-} =~ ^[0-9]+$ && "$RUNNER_UID" -ne 0 ]] || fail "invalid original runner UID"
  [[ ${EXPECTED_FIXTURE_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || fail "missing fixture digest"
  local tool
  for tool in useradd runuser userdel groupdel getent install stat realpath sha256sum python3; do
    command -v "$tool" >/dev/null || fail "missing isolation capability: $tool"
  done
  local account="occln_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}" prefix scratch scratch_identity system_tmp
  local account_created=false creation_uncertain=false runuser_settled=true uid="" gid="" passwd_record="" group_record=""
  local fixture_source prefix_identity node_path node_dir result
  prefix="$(realpath "$1")"
  [[ -d "$1" && ! -L "$1" && "$prefix" == "$(realpath "$RUNNER_TEMP")/openclaw-npm12-prefix" && "$(stat -c %u "$prefix")" == "$RUNNER_UID" ]] || fail "prefix is not the completed task installation"
  fixture_source="$(realpath "${BASH_SOURCE[0]}")"
  [[ "$(sha256sum "$fixture_source" | cut -d ' ' -f 1)" == "$EXPECTED_FIXTURE_SHA256" ]] || fail "fixture digest mismatch"
  node_path="$(realpath "${NODE_BINARY:?Node binary is required}")"
  [[ -f "$node_path" && -x "$node_path" && "${node_path##*/}" == node ]] || fail "invalid installed Node runtime"
  node_dir="${node_path%/*}"
  local kind status
  for kind in passwd group; do
    if getent "$kind" "$account" >/dev/null; then
      fail "isolated account identity already exists"
    else
      status=$?
      [[ "$status" == 2 ]] || fail "account lookup failed"
    fi
  done
  system_tmp="$(realpath /tmp)"
  [[ -d "$system_tmp" && ! -L "$system_tmp" && "$(stat -c '%u:%a' "$system_tmp")" == '0:1777' ]] || fail "system temp is not root-owned, sticky and world-traversable"
  scratch="$(mktemp -d "$system_tmp/openclaw-native-account-XXXXXX")"
  scratch_identity="$(stat -c '%d:%i:%u:%g' "$scratch")"
  # The EXIT trap invokes this while the account's local state remains in scope.
  # shellcheck disable=SC2329
  cleanup_account() {
    local original=$? cleanup_result=0 current lookup_status
    trap - ERR EXIT
    if [[ "$creation_uncertain" == true || "$runuser_settled" != true || -L "$scratch" || "$(stat -c '%d:%i:%u:%g' "$scratch" 2>/dev/null || true)" != "$scratch_identity" ]]; then
      echo "native-cleanup isolation: unresolved ownership; account and scratch retained" >&2
      exit "$((original == 0 ? 1 : original))"
    fi
    if [[ "$account_created" == true ]]; then
      if [[ "$(getent passwd "$account" || true)" != "$passwd_record" || "$(getent group "$account" || true)" != "$group_record" ]]; then
        echo "native-cleanup isolation: account identity changed; scratch retained" >&2
        exit "$((original == 0 ? 1 : original))"
      fi
      # Nonforce deletion refuses a busy UID before any candidate files are removed.
      if ! userdel "$account"; then
        echo "native-cleanup isolation: account busy or deletion refused; scratch retained" >&2
        exit "$((original == 0 ? 1 : original))"
      fi
      if current="$(getent group "$account")"; then
        if [[ "$current" != "$group_record" ]] || ! groupdel "$account"; then
          echo "native-cleanup isolation: group cleanup refused; scratch retained" >&2
          exit "$((original == 0 ? 1 : original))"
        fi
      else
        lookup_status=$?
        if [[ "$lookup_status" != 2 ]]; then
          echo "native-cleanup isolation: group lookup failed; scratch retained" >&2
          exit "$((original == 0 ? 1 : original))"
        fi
      fi
    fi
    rm -rf --one-file-system -- "$scratch" || cleanup_result=1
    if [[ "$original" -ne 0 ]]; then
      exit "$original"
    fi
    exit "$cleanup_result"
  }
  trap cleanup_account EXIT
  # Exit before Bash 5 unwinds the ownership locals on an unhandled command failure.
  trap 'exit $?' ERR
  trap 'exit 130' INT
  trap 'exit 143' TERM
  [[ "$(stat -c %d "$prefix")" == "$(stat -c %d "$scratch")" ]] || fail "system temp and task prefix are on different filesystems"
  creation_uncertain=true
  useradd --system --user-group --no-create-home --home-dir "$scratch/home" \
    --shell /usr/sbin/nologin --password '!' "$account"
  account_created=true
  creation_uncertain=false
  passwd_record="$(getent passwd "$account")"
  group_record="$(getent group "$account")"
  IFS=: read -r _ _ uid gid _ _ _ <<< "$passwd_record"
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ && "$uid" -ne 0 && "$uid" != "$RUNNER_UID" && "$gid" -ne 0 ]] || fail "isolated account UID/GID was not fresh"
  [[ "$(id -G "$account")" == "$gid" && "$group_record" == "$account:x:$gid:" ]] || fail "isolated account has unexpected groups"
  [[ "$passwd_record" == "$account:x:$uid:$gid::$scratch/home:/usr/sbin/nologin" ]] || fail "isolated account identity mismatch"
  [[ "$(getent shadow "$account" | cut -d: -f2)" == '!' ]] || fail "isolated account is not locked"
  chgrp "$gid" "$scratch"
  scratch_identity="$(stat -c '%d:%i:%u:%g' "$scratch")"
  chmod 750 "$scratch"
  install -d -m 700 -o "$uid" -g "$gid" "$scratch/home" "$scratch/tmp"
  install -m 550 -o root -g "$gid" "$fixture_source" "$scratch/fixture.sh"
  [[ "$(sha256sum "$scratch/fixture.sh" | cut -d ' ' -f 1)" == "$EXPECTED_FIXTURE_SHA256" ]] || fail "staged fixture digest mismatch"
  prefix_identity="$(stat -c '%d:%i' "$prefix")"
  mv -- "$prefix" "$scratch/prefix"
  [[ "$(stat -c '%d:%i' "$scratch/prefix")" == "$prefix_identity" ]] || fail "staged prefix identity changed"
  cd /
  runuser_settled=false
  # Positional parameters belong to the isolated child shell, not this root wrapper.
  # shellcheck disable=SC2016
  if runuser -u "$account" -- env -i PATH=/usr/bin:/bin \
    /bin/sh -c '
      test -x "$1" || { echo "native-cleanup access: scratch-traversal failed" >&2; exit 1; }
      echo "native-cleanup access: scratch-traversal passed"
      test -r "$2" || { echo "native-cleanup access: fixture-readability failed" >&2; exit 1; }
      echo "native-cleanup access: fixture-readability passed"
      test -x "$3" || { echo "native-cleanup access: selected-runtime-executability failed" >&2; exit 1; }
      echo "native-cleanup access: selected-runtime-executability passed"
    ' \
    -- "$scratch" "$scratch/fixture.sh" "$node_path"; then
    runuser_settled=true
  else
    result=$?
    runuser_settled=true
    echo "native-cleanup isolation: account cannot access staged fixture/runtime" >&2
    exit "$result"
  fi
  runuser_settled=false
  if runuser -u "$account" -- env -i PATH="$node_dir:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME="$scratch/home" RUNNER_TEMP="$scratch/tmp" \
    EXPECTED_INSPECTOR_UID="$uid" \
    EXPECTED_PACKAGE_SOURCE_SHA="$EXPECTED_PACKAGE_SOURCE_SHA" EXPECTED_PACKAGE_VERSION="$EXPECTED_PACKAGE_VERSION" \
    /bin/bash "$scratch/fixture.sh" "$scratch/prefix"; then
    result=0
  else
    result=$?
  fi
  runuser_settled=true
  exit "$result"
}
if [[ ${1:-} == --isolated-account ]]; then
  shift
  run_isolated_account "$@"
fi
[[ "$(uname -s)" == Linux && "$EUID" -ne 0 ]] || fail "requires a non-root Linux host"
[[ -z ${EXPECTED_INSPECTOR_UID:-} || "$EUID" == "$EXPECTED_INSPECTOR_UID" ]] || fail "isolated inspector UID changed"
[[ $# -eq 1 ]] || fail "usage: $0 <installed-npm-prefix>"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${EXPECTED_PACKAGE_SOURCE_SHA:?expected source SHA is required}"
: "${EXPECTED_PACKAGE_VERSION:?expected package version is required}"
prefix="$(realpath "$1")"
package_root="$prefix/lib/node_modules/openclaw"
cli="$prefix/bin/openclaw"
[[ -x "$cli" ]] || fail "installed CLI is missing"
python3 - "$prefix" "$(command -v node)" <<'PY'
import os, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
node = pathlib.Path(sys.argv[2]).resolve(strict=True)
if not node.is_file() or not os.access(node, os.R_OK | os.X_OK):
    raise SystemExit("Isolated fixture cannot access the selected Node runtime")
for directory, dirs, files in os.walk(root, followlinks=False):
    for path in [pathlib.Path(directory), *(pathlib.Path(directory) / name for name in dirs + files)]:
        target = path.resolve(strict=True)
        if target != root and root not in target.parents:
            raise SystemExit("Installed prefix has an external symlink target")
        mode = os.R_OK | (os.X_OK if target.is_dir() else 0)
        if not os.access(target, mode):
            raise SystemExit("Isolated fixture cannot read the installed prefix")
PY

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
diagnostic_holder_pid=""
diagnostic_holder_birth=""
doctor_phase=""
doctor_log=""
artifact=""
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
diagnose_census_failure() {
  timeout --signal=KILL 3s python3 - "$doctor_log" "$doctor_phase" "$fixture" "$artifact" \
    "$diagnostic_holder_pid" "$diagnostic_holder_birth" <<'PY' || echo "native-cleanup diagnostic: unavailable"
import errno, json, os, pathlib, re, sys

log, phase, fixture, artifact, holder_pid, holder_birth = sys.argv[1:]
inspector_uid = os.getuid()
result = {"phase": phase, "doctorTimeIdentityProven": False, "inspectorUid": inspector_uid}

def emit():
    print("native-cleanup diagnostic: " + json.dumps(result, sort_keys=True))

def read_record(path, limit=16384):
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("oversized process record")
    return data.decode("utf-8", errors="replace")

def read_link(path):
    value = os.readlink(path)
    if len(os.fsencode(value)) > 4096:
        raise ValueError("oversized process link")
    return value

def identity(pid):
    root = pathlib.Path("/proc") / str(pid)
    fields = read_record(root / "stat").rsplit(") ", 1)[1].split()
    uids = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$", read_record(root / "status"), re.M)
    boot = read_record(pathlib.Path("/proc/sys/kernel/random/boot_id"), 128).strip()
    if uids is None or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", boot) or not re.fullmatch(r"[RSDZTtWXxKIP]", fields[0]):
        raise ValueError("invalid process metadata")
    return {"pid": pid, "ppid": int(fields[1]), "state": fields[0],
            "startTicks": int(fields[19]), "bootId": boot,
            "uids": [int(value) for value in uids.groups()]}

def within(path, root):
    return bool(root) and (path == root or path.startswith(root + "/"))

try:
    with open(log, "rb") as source:
        data = source.read(65536)
        result["logComplete"] = os.fstat(source.fileno()).st_size <= len(data)
    pids = set(re.findall(rb"Could not classify PID ([1-9][0-9]*): working directory is unavailable", data))
    result["matchingPidCount"] = len(pids)
    if not result["logComplete"] or len(pids) != 1:
        result["processObserved"] = False
        emit()
        sys.exit(0)
    pid = int(next(iter(pids)))
    if not 0 < pid <= 2147483647:
        raise ValueError("invalid PID range")
    before = identity(pid)
    root = pathlib.Path("/proc") / str(pid)
    try:
        name = os.path.basename(read_link(root / "exe"))
        exe_class = name if name in ("node", "bun", "bash", "sh", "dash", "init", "systemd") else "other"
        exe = {"class": exe_class}
    except OSError as error:
        exe = {"class": "unavailable", "errno": error.errno}
    try:
        cwd = read_link(root / "cwd")
        cwd_result = {"outcome": "readable", "withinFixture": within(cwd, fixture),
                      "withinOwnedArtifact": within(cwd, artifact)}
    except OSError as error:
        cwd_result = {"outcome": "permission-denied" if error.errno in (errno.EACCES, errno.EPERM) else "unavailable",
                      "errno": error.errno}
    after = identity(pid)
    stable = all(before[key] == after[key] for key in ("pid", "ppid", "startTicks", "bootId", "uids"))
    result.update({"processObserved": True, "identityStable": stable,
                   "birthPaired": before["bootId"] == after["bootId"] and before["startTicks"] == after["startTicks"],
                   "before": {key: value for key, value in before.items() if key != "bootId"},
                   "after": {key: value for key, value in after.items() if key != "bootId"}})
    if stable:
        result.update({"exe": exe, "cwd": cwd_result,
                       "allUidsForeign": all(uid != inspector_uid for uid in before["uids"]),
                       "matchesOriginalHolder": str(pid) == holder_pid and
                       before["bootId"] + ":" + str(before["startTicks"]) == holder_birth})
    else:
        result["classification"] = "raced-unverified"
except (OSError, ValueError, IndexError) as error:
    result.update({"processObserved": False, "classification": "unavailable-unverified",
                   "errorKind": type(error).__name__})
emit()
PY
}
cleanup() {
  local result=$?
  if [[ "$result" -ne 0 && -n "$doctor_log" ]]; then
    diagnose_census_failure
  fi
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
diagnostic_holder_pid="$holder_pid"
diagnostic_holder_birth="$holder_birth"
IFS= read -r -t 30 ready <&4 || fail "holder did not become ready"
[[ "$ready" == ready ]] || fail "unexpected holder readiness"

run_doctor() {
  doctor_log="$1"
  doctor_phase="$2"
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
echo "native-cleanup retained: live owned holder pid=$holder_pid birth-paired=true"
exec 3>&-
wait "$holder_pid" || fail "owned holder did not settle successfully"
[[ "$(process_birth "$holder_pid" || true)" != "$holder_birth" ]] || fail "settled holder still exists"
holder_pid=""
run_doctor "$fixture/removed.log" remove
assert_doctor_message "$fixture/removed.log" remove
[[ ! -e "$artifact" && ! -L "$artifact" ]] || fail "abandoned runtime remains"
[[ "$(cat "$fixture/tmp/keep.txt")" == 'unrelated sentinel' ]] || fail "unrelated sentinel changed"
echo "native-cleanup passed: holder settled, removal reported, runtime absent, unrelated sentinel preserved"
