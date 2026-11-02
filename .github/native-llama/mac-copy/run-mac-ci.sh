#!/bin/bash
set -euo pipefail
packet="$(cd "$(dirname "$0")" && pwd -P)"
[[ "$#" == 3 && "$3" == /* && ! -e "$3" ]]
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]]
[[ "${LLAMA_GITHUB_HOSTED_ACK:-}" == task-owned-secretless-github-hosted ]]
mkdir -p "$3"
output="$(cd "$3" && pwd -P)"
cd "$packet"
/usr/bin/shasum -a 256 -c INPUT-SHA256SUMS > "$output/input-admission.log" 2>&1
# Bash 3.2 foreground pipeline owns and joins both writer processes.
set +e
/bin/bash --noprofile --norc "$packet/worker.sh" "$1" "$2" "$output" 2>&1 | /usr/bin/tee "$output/run.log"
statuses=("${PIPESTATUS[@]}")
set -e
worker_status=${statuses[0]}
logger_status=${statuses[1]}
printf 'worker=%s logger=%s\n' "$worker_status" "$logger_status" > "$output/pipeline-status.txt"
status=0
if [[ "$worker_status" != 0 || "$logger_status" != 0 ]]; then
  status=1
  printf '%s\n' 'FAILED_PARTIAL_EVIDENCE_NOT_NATIVE_PROOF' > "$output/CAPTURE-STATUS.txt"
else
  python3 -I -S "$packet/verify-results.py" all "$output" > "$output/result-validation.log" 2>&1 || status=$?
  if [[ "$status" == 0 ]]; then
    printf '%s\n' 'NATIVE_COPY_CAPTURE_COMPLETED_REQUIRES_PARENT_PIXEL_INSPECTION_AND_DELIVERY' > "$output/CAPTURE-STATUS.txt"
  else
    printf '%s\n' 'FAILED_RESULT_VALIDATION_NOT_NATIVE_PROOF' > "$output/CAPTURE-STATUS.txt"
  fi
fi
# No worker/logger/validator output writer remains. Seal complete or honestly failed evidence.
python3 -I -S "$packet/verify-results.py" seal "$output"
exit "$status"
