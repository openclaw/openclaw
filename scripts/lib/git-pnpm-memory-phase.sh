#!/usr/bin/env bash
# Runs one diagnostic command, samples its process tree, and records raw resource evidence.
# The outer runner gives each invocation a fresh Docker cgroup so memory.peak is phase-local.
set -uo pipefail

result_dir="${PHASE_RESULT_DIR:?PHASE_RESULT_DIR is required}"
timeout_seconds="${PHASE_TIMEOUT_SECONDS:?PHASE_TIMEOUT_SECONDS is required}"
mkdir -p "$result_dir"

read_cgroup_file() {
  local name="$1"
  local destination="$2"
  if [ -r "/sys/fs/cgroup/$name" ]; then
    cp "/sys/fs/cgroup/$name" "$destination"
  fi
}

read_cgroup_file memory.current "$result_dir/memory.current.before"
read_cgroup_file memory.peak "$result_dir/memory.peak.before"
read_cgroup_file memory.events "$result_dir/memory.events.before"
read_cgroup_file pids.events "$result_dir/pids.events.before"

/usr/bin/time -v -o "$result_dir/time.txt" \
  timeout --signal=TERM --kill-after=15s "${timeout_seconds}s" "$@" \
  >"$result_dir/stdout.log" 2>"$result_dir/stderr.log" &
command_pid=$!

sample_processes() {
  while kill -0 "$command_pid" 2>/dev/null; do
    sample="$(date +%s%3N)"
    memory_current="$(cat /sys/fs/cgroup/memory.current 2>/dev/null || printf '0')"
    ps -ww -eo pid=,ppid=,rss=,nlwp=,comm=,args= | \
      while read -r pid ppid rss threads command args; do
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sample" "$memory_current" "$pid" "$ppid" "$rss" "$threads" "$command" "$args"
    done >>"$result_dir/process-samples.tsv"
    sleep 0.2
  done
}

sample_processes &
sampler_pid=$!
wait "$command_pid"
exit_code=$?
wait "$sampler_pid" 2>/dev/null || true
printf '%s\n' "$exit_code" >"$result_dir/exit-code"

read_cgroup_file memory.current "$result_dir/memory.current.after"
read_cgroup_file memory.peak "$result_dir/memory.peak.after"
read_cgroup_file memory.events "$result_dir/memory.events.after"
read_cgroup_file pids.events "$result_dir/pids.events.after"

# A timeout must not silently hand the next retry live pack/install children.
ps -ww -eo pid=,ppid=,rss=,comm=,args= | \
  awk '($4 == "git" && $0 ~ /(pack-objects|upload-pack)/) ||
       ($4 ~ /^git-(pack-objects|upload-pack)$/) ||
       ($4 == "pnpm") ||
       ($4 == "node" && $0 ~ /\/pnpm([ .]|$)/) { print }' \
  >"$result_dir/lingering-processes.txt" || true

if [ -n "${DIAG_DISK_PATH:-}" ] && [ -e "$DIAG_DISK_PATH" ]; then
  du -sb "$DIAG_DISK_PATH" | awk '{ print $1 }' >"$result_dir/disk-bytes"
fi

if [ -n "${DIAG_GIT_PATH:-}" ] && [ -e "$DIAG_GIT_PATH" ]; then
  git -C "$DIAG_GIT_PATH" count-objects -vH >"$result_dir/git-count-objects.txt" 2>&1 || true
  git -C "$DIAG_GIT_PATH" status --short >"$result_dir/git-status-short.txt" 2>&1 || true
  git_dir="$(git -C "$DIAG_GIT_PATH" rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [ -n "$git_dir" ]; then
    du -sh "$git_dir" >"$result_dir/git-du.txt" 2>&1 || true
    find "$git_dir/objects/pack" -maxdepth 1 -type f -printf '%s\n' 2>/dev/null | \
      awk '{ total += $1 } END { print total + 0 }' >"$result_dir/git-pack-bytes"
  fi
  if [ -d "$DIAG_GIT_PATH/node_modules" ]; then
    du -sh "$DIAG_GIT_PATH/node_modules" >"$result_dir/node-modules-du.txt" 2>&1 || true
    du -sb "$DIAG_GIT_PATH/node_modules" | awk '{ print $1 }' >"$result_dir/node-modules-bytes"
  fi
  if [ -f "$DIAG_GIT_PATH/package.json" ]; then
    DIAG_GIT_PATH="$DIAG_GIT_PATH" node <<'NODE' >"$result_dir/repository-metadata.json"
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.DIAG_GIT_PATH;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
let packageManifests = 0;
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", ".pnpm-store"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.name === "package.json") packageManifests += 1;
  }
};
visit(root);
process.stdout.write(`${JSON.stringify({
  node: process.version,
  packageManager: manifest.packageManager ?? null,
  engines: manifest.engines ?? null,
  packageManifests,
  lifecycleScripts: Object.fromEntries(
    ["preinstall", "install", "postinstall", "prepare", "build"]
      .filter((name) => manifest.scripts?.[name])
      .map((name) => [name, manifest.scripts[name]]),
  ),
}, null, 2)}\n`);
NODE
    git -C "$DIAG_GIT_PATH" ls-tree -r -l HEAD 2>/dev/null | \
      sort -k4,4nr | head -20 >"$result_dir/largest-head-blobs.txt" || true
  fi
fi

printf '[%s] exit=%s\n' "${PHASE_NAME:-phase}" "$exit_code"
exit "$exit_code"
