#!/usr/bin/env bash
set -euo pipefail

# Fixed workflow scenarios only; this is not a general emulator/command runner.
if [[ "$#" != "1" ]]; then
  echo "Expected phone, wear, or phone-then-wear diagnostic scenario." >&2
  exit 2
fi
: "${DIAGNOSTIC_DIR:?Diagnostic artifact directory is required}"
case "$1" in
  phone-then-wear)
    # Each child owns and joins its emulator before the next launch. A failed
    # phone gate stops the sequence, exactly as the screenshot entrypoint does.
    DIAGNOSTIC_DIR="$DIAGNOSTIC_DIR/phone" bash "$0" phone
    exec bash "$0" wear
    ;;
  phone)
    # Preserve the released standalone phone root alongside workflow setup evidence.
    AVD_NAME=OpenClaw_Screenshots_API36
    DEVICE_PROFILE=pixel_2
    SYSTEM_IMAGE='system-images;android-36;google_apis;x86_64'
    ;;
  wear)
    DIAGNOSTIC_DIR="$DIAGNOSTIC_DIR/wear"
    AVD_NAME=OpenClaw_Wear_Screenshots_API34
    DEVICE_PROFILE=wearos_large_round
    SYSTEM_IMAGE='system-images;android-34;android-wear;x86_64'
    ;;
  *)
    echo "Expected phone, wear, or phone-then-wear diagnostic scenario." >&2
    exit 2
    ;;
esac
mkdir -p "$DIAGNOSTIC_DIR"
ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS=180
emulator_pid=""
adb_started=0
readiness_failure_latched=0
final_cold_boot_observation_seconds=900
emulator_observation_deadline=0
last_accel_status=unobserved
last_accel_timed_out=unobserved

capture_accel_check() {
  local accel_raw="$DIAGNOSTIC_DIR/emulator-accel-check.raw"
  local accel_check_timeout_seconds=10
  local accel_deadline
  local accel_pid
  local accel_status
  local accel_timed_out=false

  emulator -accel-check >"$accel_raw" 2>&1 &
  accel_pid=$!
  accel_deadline=$((SECONDS + accel_check_timeout_seconds))
  while kill -0 "$accel_pid" 2>/dev/null; do
    if (( SECONDS >= accel_deadline )); then
      accel_timed_out=true
      if kill "$accel_pid" 2>/dev/null; then
        :
      fi
      if kill -0 "$accel_pid" 2>/dev/null && kill -9 "$accel_pid" 2>/dev/null; then
        :
      fi
      break
    fi
    sleep 1
  done
  if wait "$accel_pid"; then
    accel_status=0
  else
    accel_status=$?
  fi
  if [[ "$accel_timed_out" == "true" ]]; then
    accel_status=124
  fi
  last_accel_status="$accel_status"
  last_accel_timed_out="$accel_timed_out"
  if [[ "$accel_status" != "0" ]]; then
    capture_kvm_transition acceleration-probe-failed || :
  fi
  head -c 16384 "$accel_raw" >"$DIAGNOSTIC_DIR/emulator-accel-check.txt"
  rm -f "$accel_raw"
  printf 'exit_status=%s\n' "$accel_status" >>"$DIAGNOSTIC_DIR/emulator-accel-check.txt"
  printf 'timed_out=%s\n' "$accel_timed_out" >>"$DIAGNOSTIC_DIR/emulator-accel-check.txt"
  return 0
}

sample_owned_qemu() {
  sample_status=0
  {
    printf '\n[%s] owned_emulator_pid=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$emulator_pid"
    ps -p "$emulator_pid" -o pid=,ppid=,%cpu=,rss=,stat=,etime=,command=
  } >>"$DIAGNOSTIC_DIR/owned-qemu-samples.log" 2>&1 || sample_status=$?
  if [[ "$sample_status" -ne 0 ]]; then
    printf 'sample_status=%s\n' "$sample_status" \
      >>"$DIAGNOSTIC_DIR/owned-qemu-samples.log"
  fi
  return 0
}

run_bounded_probe() {
  local output_file="$1"
  local deadline="$2"
  shift 2
  local probe_deadline
  local probe_pid
  local probe_poll_seconds=0.1
  local probe_timeout_seconds=5

  probe_status=0
  probe_timed_out=false
  : >"$output_file"
  if (( SECONDS >= deadline )); then
    probe_status=124
    probe_timed_out=true
    return 0
  fi

  probe_deadline=$((SECONDS + probe_timeout_seconds))
  if (( probe_deadline > deadline )); then
    probe_deadline=$deadline
  fi
  "$@" >"$output_file" 2>&1 &
  probe_pid=$!
  while kill -0 "$probe_pid" 2>/dev/null; do
    if (( SECONDS >= probe_deadline )); then
      probe_timed_out=true
      if kill "$probe_pid" 2>/dev/null; then
        :
      fi
      if kill -0 "$probe_pid" 2>/dev/null && kill -9 "$probe_pid" 2>/dev/null; then
        :
      fi
      break
    fi
    sleep "$probe_poll_seconds"
  done
  if wait "$probe_pid" 2>/dev/null; then
    probe_status=0
  else
    probe_status=$?
  fi
  if (( SECONDS >= probe_deadline )); then
    probe_timed_out=true
  fi
  if [[ "$probe_timed_out" == "true" ]]; then
    probe_status=124
  fi
}

retain_probe_output() {
  local source_file="$1"
  local destination_file="$2"
  local max_bytes="$3"
  local exit_status="$4"
  local timed_out="$5"
  local output_bytes
  local output_truncated=false
  local retained_bytes

  output_bytes="$(wc -c <"$source_file" | tr -d ' ')"
  retained_bytes="$output_bytes"
  if (( output_bytes > max_bytes )); then
    head -c "$max_bytes" "$source_file" >"$destination_file"
    retained_bytes="$max_bytes"
    output_truncated=true
  else
    cp "$source_file" "$destination_file"
  fi
  rm -f "$source_file"
  {
    printf '\nprobe_exit_status=%s\n' "$exit_status"
    printf 'probe_timed_out=%s\n' "$timed_out"
    printf 'output_bytes=%s\n' "$output_bytes"
    printf 'retained_bytes=%s\n' "$retained_bytes"
    printf 'output_truncated=%s\n' "$output_truncated"
  } >>"$destination_file"
}

# Observations only: the workflow remains the sole admission/permission owner.
# Never dereference a device override or a symlink; snapshots are non-atomic facts,
# not an authorization decision. No stderr or unvalidated tool text is retained.
capture_kvm_transition() {
  local checkpoint="$1"
  local snapshot_dir="$DIAGNOSTIC_DIR/kvm-transitions/$checkpoint"
  local checkpoint_deadline=$((SECONDS + 3))
  local probe_status=0 probe_timed_out=false
  local kind raw line key output_bytes command_deadline
  local -A seen=()
  local shape_valid complete saw_complete saw_user saw_group saw_other saw_mask saw_named
  local state_character=false
  local state_reader='
import os, stat, time
complete = True
def emit(key, value):
    print(f"{key}={value}", flush=True)
def observe(name, read):
    global complete
    try:
        return read()
    except (OSError, ValueError, NotImplementedError) as error:
        emit(name + "_errno", getattr(error, "errno", None) or 0)
        complete = False
        return None
emit("utc_epoch_ns", time.time_ns())
emit("monotonic_ns", time.monotonic_ns())
for name, read in [("real_uid", os.getuid), ("effective_uid", os.geteuid),
                   ("real_gid", os.getgid), ("effective_gid", os.getegid)]:
    value = observe(name, read)
    if value is not None: emit(name, value)
groups = observe("groups", os.getgroups)
if groups is not None:
    emit("groups", " ".join(str(group) for group in groups))
def device_state(name, read):
    value = observe(name, read)
    if value is not None:
        for key in ["dev", "ino", "rdev", "uid", "gid", "mode", "ctime_ns"]:
            emit(name + "_" + key, getattr(value, "st_" + key))
        emit(name + "_type", stat.S_IFMT(value.st_mode))
    return value
before = device_state("lstat", lambda: os.lstat("/dev/kvm"))
if before is not None and stat.S_ISCHR(before.st_mode):
    after = device_state("stat", lambda: os.stat("/dev/kvm", follow_symlinks=False))
    if after is not None and stat.S_ISCHR(after.st_mode):
        emit("same_identity", int((before.st_dev, before.st_ino, before.st_rdev) ==
                                  (after.st_dev, after.st_ino, after.st_rdev)))
        for name, mode in [("read", os.R_OK), ("write", os.W_OK)]:
            for credential, effective in [("real", False), ("effective", True)]:
                key = name + "_" + credential
                value = observe(key, lambda: os.access("/dev/kvm", mode,
                    effective_ids=effective, follow_symlinks=False))
                if value is not None: emit(key, int(value))
    else:
        complete = False
else:
    complete = False
emit("complete", int(complete))
'

  local acl_reader='
import os, stat, sys
try:
    # O_PATH obtains metadata only; it never invokes the KVM device open method.
    # Bind the ACL utility to this no-follow descriptor, not a mutable pathname.
    fd = os.open("/dev/kvm", os.O_PATH | os.O_NOFOLLOW)
    device = os.fstat(fd)
    for key in ["dev", "ino", "rdev", "uid", "gid", "mode", "ctime_ns"]:
        value = getattr(device, "st_" + key)
        print(f"acl_{key}={value}", flush=True)
    print(f"acl_type={stat.S_IFMT(device.st_mode)}", flush=True)
    if not stat.S_ISCHR(device.st_mode):
        sys.exit(125)
    os.set_inheritable(fd, True)
    os.execvp("getfacl", ["getfacl", "-ncpE", "--", f"/proc/self/fd/{fd}"])
except OSError as error:
    print(f"acl_errno={error.errno or 0}", flush=True)
    sys.exit(127 if isinstance(error, FileNotFoundError) else 1)
'

  case "$checkpoint" in
    entry-pre-probe|pre-launch|before-owned-signal|after-owned-wait|after-cleanup|acceleration-probe-failed) ;;
    *) return 0 ;;
  esac
  if ! mkdir -p "$snapshot_dir"; then
    printf 'KVM observer: artifact directory unavailable; snapshot incomplete.\n' >&2
    return 0
  fi
  # Cleanup never buys more live observation time after the permanent failure latch.
  if [[ "$readiness_failure_latched" == "1" ]] &&
    (( emulator_observation_deadline < checkpoint_deadline )); then
    checkpoint_deadline=$emulator_observation_deadline
  fi
  {
    printf 'checkpoint=%s\n' "$checkpoint"
    printf 'admission_relation=after-workflow-admission-not-acl-grant\n'
    printf 'atomic=false\n'
    printf 'shell_elapsed_seconds=%s\n' "$SECONDS"
    if [[ ! -v ANDROID_EMULATOR_KVM_DEVICE ]]; then
      printf 'kvm_device_override=unset\n'
    elif [[ "$ANDROID_EMULATOR_KVM_DEVICE" == /dev/kvm ]]; then
      printf 'kvm_device_override=default\n'
    else
      printf 'kvm_device_override=nondefault\n'
    fi
    printf 'accel_exit_status=%s\n' "${last_accel_status:-unobserved}"
    printf 'accel_timed_out=%s\n' "${last_accel_timed_out:-unobserved}"
  } >"$snapshot_dir/metadata.txt"

  for kind in state acl; do
    raw="$snapshot_dir/$kind.raw"
    command_deadline=$((SECONDS + 2))
    if (( command_deadline > checkpoint_deadline )); then
      command_deadline=$checkpoint_deadline
    fi
    if [[ "$kind" == state ]]; then
      # exec keeps the probe owner identical to the reader; the writer itself is
      # capped at 16 KiB, not merely trimmed after an unbounded temporary write.
      run_bounded_probe "$raw" "$command_deadline" bash -c \
        'ulimit -c 0 && ulimit -f 16 || exit 125; exec python3 -I -S -c "$1" 2>/dev/null' kvm-state "$state_reader"
    elif [[ "$state_character" == true ]]; then
      run_bounded_probe "$raw" "$command_deadline" bash -c \
        'ulimit -c 0 && ulimit -f 16 || exit 125; exec python3 -I -S -c "$1" 2>/dev/null' kvm-acl "$acl_reader"
    else
      : >"$raw"
      probe_status=125
      probe_timed_out=false
    fi
    output_bytes="$(wc -c <"$raw" | tr -d ' ')"
    shape_valid=true
    seen=()
    complete=false
    saw_complete=false saw_user=false saw_group=false saw_other=false saw_mask=false saw_named=false
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$kind" == state ]]; then
        if [[ "$line" =~ ^(utc_epoch_ns|monotonic_ns|real_uid|effective_uid|real_gid|effective_gid|((lstat|stat)_(dev|ino|rdev|uid|gid|mode|ctime_ns|type))|same_identity|((read|write)_(real|effective))|complete|((real_uid|effective_uid|real_gid|effective_gid|groups|lstat|stat|((read|write)_(real|effective)))_errno))=[0-9]+$ ||
          "$line" =~ ^groups=([0-9]+(\ [0-9]+)*)?$ ]]; then
          key="${line%%=*}"
          [[ ! -v seen[$key] ]] || shape_valid=false
          seen[$key]=1
          [[ "$line" != complete=1 ]] || saw_complete=true
          [[ "$line" != stat_type=8192 ]] || state_character=true
        else
          shape_valid=false
        fi
      elif [[ "$line" =~ ^acl_(errno|dev|ino|rdev|uid|gid|mode|ctime_ns|type)=[0-9]+$ ]]; then
        key="${line%%=*}"
        [[ ! -v seen[$key] ]] || shape_valid=false
        seen[$key]=1
      elif [[ -z "$line" ]]; then
        :
      elif [[ "$line" =~ ^(user|group):[0-9]*:[r-][w-][x-]$ ||
        "$line" =~ ^(mask|other)::[r-][w-][x-]$ ]]; then
        key="${line%:*}"
        [[ ! -v seen[$key] ]] || shape_valid=false
        seen[$key]=1
        case "$line" in
          user::*) saw_user=true ;;
          group::*) saw_group=true ;;
          other::*) saw_other=true ;;
          mask::*) saw_mask=true ;;
          *) saw_named=true ;;
        esac
      else
        shape_valid=false
      fi
    done <"$raw"
    if [[ "$kind" == state ]]; then
      for key in utc_epoch_ns monotonic_ns real_uid effective_uid real_gid effective_gid groups \
        lstat_dev lstat_ino lstat_rdev lstat_uid lstat_gid lstat_mode lstat_ctime_ns lstat_type \
        stat_dev stat_ino stat_rdev stat_uid stat_gid stat_mode stat_ctime_ns stat_type \
        same_identity read_real read_effective write_real write_effective complete; do
        [[ -v seen[$key] ]] || saw_complete=false
      done
    fi
    if [[ "$kind" == acl && "$saw_user$saw_group$saw_other" == truetruetrue &&
      ( "$saw_named" == false || "$saw_mask" == true ) ]]; then
      saw_complete=true
      for key in acl_dev acl_ino acl_rdev acl_uid acl_gid acl_mode acl_ctime_ns acl_type; do
        [[ -v seen[$key] ]] || saw_complete=false
      done
    fi
    if [[ "$shape_valid" != true ]]; then
      # Discard the whole payload rather than leaking error text or claiming a
      # partial ACL (especially a missing mask) was a complete observation.
      : >"$raw"
      state_character=false
    fi
    if [[ "$shape_valid$saw_complete" == truetrue && "$probe_status" == 0 &&
      "$probe_timed_out" == false ]] && (( output_bytes <= 8192 )); then
      complete=true
    fi
    retain_probe_output "$raw" "$snapshot_dir/$kind.txt" 8192 "$probe_status" "$probe_timed_out"
    {
      printf 'source_bytes=%s\n' "$output_bytes"
      if (( output_bytes >= 16384 )); then
        printf 'source_limit_reached=true\n'
      fi
      printf 'shape_valid=%s\n' "$shape_valid"
      printf 'complete=%s\n' "$complete"
    } >>"$snapshot_dir/$kind.txt"
  done
  return 0
}

capture_cold_boot_snapshot() {
  local snapshot_name="$1"
  local serial="$2"
  local observation_deadline="$3"
  local snapshot_properties_max_bytes=65536
  local snapshot_logcat_max_bytes=262144
  local snapshot_dir="$DIAGNOSTIC_DIR/cold-boot-snapshots/$snapshot_name"
  local probe_output="$DIAGNOSTIC_DIR/cold-boot-snapshot.raw"
  local remaining_seconds=$((observation_deadline - SECONDS))

  if (( remaining_seconds < 0 )); then
    remaining_seconds=0
  fi
  mkdir -p "$snapshot_dir"
  {
    printf 'snapshot=%s\n' "$snapshot_name"
    printf 'captured_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'serial=%s\n' "$serial"
    printf 'avd_name=%s\n' "$AVD_NAME"
    printf 'remaining_seconds_at_start=%s\n' "$remaining_seconds"
  } >"$snapshot_dir/metadata.txt"

  run_bounded_probe "$probe_output" "$observation_deadline" \
    adb -s "$serial" shell getprop
  retain_probe_output "$probe_output" "$snapshot_dir/boot-properties.txt" \
    "$snapshot_properties_max_bytes" "$probe_status" "$probe_timed_out"

  run_bounded_probe "$probe_output" "$observation_deadline" \
    adb -s "$serial" logcat -b system -b crash -d -v threadtime -t 2000
  retain_probe_output "$probe_output" "$snapshot_dir/system-crash-logcat.txt" \
    "$snapshot_logcat_max_bytes" "$probe_status" "$probe_timed_out"
}

observe_after_readiness_timeout() {
  local serial="${1:-}"
  local observation_deadline="$2"
  local observation_poll_seconds=2
  local final_snapshot_lead_seconds=15
  local observation_log="$DIAGNOSTIC_DIR/post-deadline-observations.log"
  local observation_stop="observation-cap-reached"
  local late_adb_recorded=false
  local first_snapshot_recorded=false
  local final_snapshot_recorded=false
  local observed_at
  local probe_output="$DIAGNOSTIC_DIR/post-deadline-probe.raw"
  local adb_output
  local serials
  local count
  local avd_name
  local boot_completed
  local remaining_seconds

  {
    printf 'original_deadline_reached_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'observation_cap_seconds=%s\n' "$final_cold_boot_observation_seconds"
    printf 'owned_emulator_pid=%s\n' "$emulator_pid"
  } >>"$observation_log"

  while (( SECONDS < observation_deadline )); do
    observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if ! kill -0 "$emulator_pid" 2>/dev/null; then
      observation_stop="owned-emulator-exited"
      printf '[%s] owned_emulator_exited=true\n' "$observed_at" >>"$observation_log"
      break
    fi

    run_bounded_probe "$probe_output" "$observation_deadline" adb devices -l
    adb_output="$(head -c 16384 "$probe_output")"
    {
      printf '\n[%s] post-deadline adb_status=%s adb_timed_out=%s\n' \
        "$observed_at" "$probe_status" "$probe_timed_out"
      printf '%s\n' "$adb_output"
    } >>"$observation_log"
    if [[ "$probe_timed_out" == "false" && "$probe_status" == "0" ]]; then
      serials="$(printf '%s\n' "$adb_output" | awk 'NR > 1 && $2 == "device" { print $1 }')"
      count="$(printf '%s\n' "$serials" | sed '/^$/d' | wc -l | tr -d ' ')"
      if [[ "$count" -gt 1 ]]; then
        observation_stop="unexpected-multiple-devices"
        break
      fi
      if [[ "$count" == "1" ]]; then
        if [[ -n "$serial" && "$serial" != "$serials" ]]; then
          observation_stop="unexpected-device-change"
          break
        fi
        if [[ -z "$serial" ]]; then
          serial="$serials"
        fi
        run_bounded_probe "$probe_output" "$observation_deadline" \
          adb -s "$serial" emu avd name
        avd_name="$(head -c 4096 "$probe_output" | tr -d '\r' | sed -n '1p')"
        printf '[%s] serial=%s avd_status=%s avd_timed_out=%s avd_name=%s\n' \
          "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$serial" "$probe_status" \
          "$probe_timed_out" "${avd_name:-unset}" >>"$observation_log"
        if [[ "$probe_timed_out" == "false" && "$probe_status" == "0" ]]; then
          if [[ "$avd_name" != "$AVD_NAME" ]]; then
            observation_stop="unexpected-avd"
            break
          fi
          if [[ "$late_adb_recorded" == "false" ]]; then
            printf 'late_adb_online_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
              >>"$observation_log"
            late_adb_recorded=true
          fi
          if [[ "$first_snapshot_recorded" == "false" ]]; then
            capture_cold_boot_snapshot "first-online" "$serial" "$observation_deadline"
            first_snapshot_recorded=true
          fi

          if (( SECONDS < observation_deadline )); then
            run_bounded_probe "$probe_output" "$observation_deadline" \
              adb -s "$serial" shell getprop sys.boot_completed
            boot_completed="$(tr -d '\r' <"$probe_output")"
            printf '[%s] serial=%s boot_status=%s boot_timed_out=%s boot_completed=%s\n' \
              "$observed_at" "$serial" "$probe_status" "$probe_timed_out" \
              "${boot_completed:-unset}" >>"$observation_log"
            if [[ "$probe_timed_out" == "false" && "$probe_status" == "0" &&
              "$boot_completed" == "1" ]]; then
              printf 'late_boot_completed_at=%s\n' \
                "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$observation_log"
              observation_stop="late-boot-completed"
              break
            fi
            remaining_seconds=$((observation_deadline - SECONDS))
            if [[ "$final_snapshot_recorded" == "false" ]] &&
              (( remaining_seconds <= final_snapshot_lead_seconds )); then
              capture_cold_boot_snapshot \
                "near-ceiling" "$serial" "$observation_deadline"
              final_snapshot_recorded=true
            fi
          fi
        fi
      fi
    fi

    if (( SECONDS >= observation_deadline )); then
      break
    fi
    sample_owned_qemu
    remaining_seconds=$((observation_deadline - SECONDS))
    if (( remaining_seconds <= 0 )); then
      break
    fi
    if (( remaining_seconds < observation_poll_seconds )); then
      sleep "$remaining_seconds"
    else
      sleep "$observation_poll_seconds"
    fi
  done

  rm -f "$probe_output"
  printf 'observation_finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >>"$observation_log"
  printf 'first_snapshot_recorded=%s\n' "$first_snapshot_recorded" >>"$observation_log"
  printf 'final_snapshot_recorded=%s\n' "$final_snapshot_recorded" >>"$observation_log"
  printf 'observation_stop=%s\n' "$observation_stop" >>"$observation_log"
}

fail_after_readiness_timeout() {
  local failure_message="$1"
  local serial="${2:-}"

  readiness_failure_latched=1
  observe_after_readiness_timeout "$serial" "$emulator_observation_deadline"
  printf '::error::%s\n' "$failure_message" >&2
  return 1
}

cleanup() {
  status=$?
  set +e
  {
    printf 'exit_status=%s\n' "$status"
    printf 'finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [[ -n "$emulator_pid" ]]; then
      ps -p "$emulator_pid" -o pid=,ppid=,stat=,etime=,command=
    fi
    if [[ "$readiness_failure_latched" == "1" ]]; then
      printf 'adb_devices_skipped_after_latched_timeout=true\n'
    else
      adb devices -l
    fi
  } >>"$DIAGNOSTIC_DIR/process-status.log" 2>&1
  if [[ -n "$emulator_pid" ]] && kill -0 "$emulator_pid" 2>/dev/null; then
    capture_kvm_transition before-owned-signal || :
    kill "$emulator_pid"
    for _ in {1..15}; do
      kill -0 "$emulator_pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$emulator_pid" 2>/dev/null; then
      kill -9 "$emulator_pid"
    fi
  fi
  if [[ -n "$emulator_pid" ]]; then
    if wait "$emulator_pid" 2>/dev/null; then
      emulator_exit_status=0
    else
      emulator_exit_status=$?
    fi
    capture_kvm_transition after-owned-wait || :
    printf 'owned_emulator_exit_status=%s\n' "$emulator_exit_status" >>"$DIAGNOSTIC_DIR/process-status.log"
  fi
  if [[ "$adb_started" == "1" && "$readiness_failure_latched" != "1" ]]; then
    adb kill-server
  elif [[ "$adb_started" == "1" ]]; then
    printf 'adb_kill_server_skipped_after_latched_timeout=true\n' \
      >>"$DIAGNOSTIC_DIR/cleanup.log"
  fi
  avdmanager delete avd --name "$AVD_NAME" \
    >>"$DIAGNOSTIC_DIR/cleanup.log" 2>&1
  capture_kvm_transition after-cleanup || :
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

emulator -no-window -no-audio -version >"$DIAGNOSTIC_DIR/emulator-version.txt" 2>&1
capture_kvm_transition entry-pre-probe || :
capture_accel_check
sdkmanager --list_installed >"$DIAGNOSTIC_DIR/sdk-packages.txt" 2>&1
avdmanager list device >"$DIAGNOSTIC_DIR/avd-devices.txt" 2>&1
adb start-server
adb_started=1
adb devices -l >"$DIAGNOSTIC_DIR/adb-before.txt"
if adb devices | awk 'NR > 1 && $2 != "" { found = 1 } END { exit !found }'; then
  echo "::error::Expected no connected Android devices before diagnostic startup"
  exit 1
fi

printf 'no\n' | avdmanager create avd --force --name "$AVD_NAME" --package "$SYSTEM_IMAGE" --device "$DEVICE_PROFILE"
cp "$HOME/.android/avd/${AVD_NAME}.avd/config.ini" "$DIAGNOSTIC_DIR/avd-config.ini"

emulator_args=(-avd "$AVD_NAME" -no-window -no-audio -no-boot-anim -verbose -show-kernel)
printf '%q ' "${emulator_args[@]}" >"$DIAGNOSTIC_DIR/emulator-args.txt"
printf '\n' >>"$DIAGNOSTIC_DIR/emulator-args.txt"
capture_kvm_transition pre-launch || :
emulator_launch_seconds=$SECONDS
emulator_observation_deadline=$((emulator_launch_seconds + final_cold_boot_observation_seconds))
emulator "${emulator_args[@]}" >"$DIAGNOSTIC_DIR/emulator.log" 2>&1 &
emulator_pid=$!
printf 'emulator_pid=%s\n' "$emulator_pid" >"$DIAGNOSTIC_DIR/process-status.log"
sample_owned_qemu

device_deadline=$((SECONDS + ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS))
serial=""
while (( SECONDS < device_deadline )); do
  {
    printf '\n[%s] waiting for one device\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    adb devices -l
  } >>"$DIAGNOSTIC_DIR/adb-observations.log" 2>&1
  serials="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
  count="$(printf '%s\n' "$serials" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$count" == "1" ]]; then
    serial="$serials"
    break
  fi
  if [[ "$count" -gt 1 ]]; then
    echo "::error::Multiple Android devices appeared during diagnostic startup"
    exit 1
  fi
  sample_owned_qemu
  ps -p "$emulator_pid" -o pid=,ppid=,stat=,etime=,command= \
    >>"$DIAGNOSTIC_DIR/process-status.log" 2>&1
  kill -0 "$emulator_pid"
  sleep 2
done
if [[ -z "$serial" ]]; then
  fail_after_readiness_timeout \
    "Timed out waiting for exactly one Android emulator device" ""
fi

avd_name="$(adb -s "$serial" emu avd name 2>/dev/null | tr -d '\r' | sed -n '1p')"
if [[ "$avd_name" != "$AVD_NAME" ]]; then
  echo "::error::Unexpected Android AVD during diagnostic startup" >&2
  exit 1
fi
adb -s "$serial" wait-for-device
boot_deadline=$((SECONDS + ANDROID_SCREENSHOT_EMULATOR_TIMEOUT_SECONDS))
while (( SECONDS < boot_deadline )); do
  boot_completed="$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  {
    printf '\n[%s] serial=%s boot_completed=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$serial" "${boot_completed:-unset}"
    adb devices -l
  } >>"$DIAGNOSTIC_DIR/adb-observations.log" 2>&1
  sample_owned_qemu
  ps -p "$emulator_pid" -o pid=,ppid=,stat=,etime=,command= \
    >>"$DIAGNOSTIC_DIR/process-status.log" 2>&1
  kill -0 "$emulator_pid"
  if [[ "$boot_completed" == "1" ]]; then
    {
      printf 'serial=%s\n' "$serial"
      printf 'avd=%s\n' "$(adb -s "$serial" emu avd name 2>/dev/null | tr -d '\r' | sed -n '1p')"
      printf 'boot_completed=1\n'
    } >"$DIAGNOSTIC_DIR/result.txt"
    exit 0
  fi
  sleep 2
done

fail_after_readiness_timeout \
  "Timed out waiting for Android emulator boot completion" "$serial"
