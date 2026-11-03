#!/bin/bash
set -euo pipefail
packet="$(cd "$(dirname "$0")" && pwd -P)"
[[ "$#" == 2 && "$2" == /* && ! -e "$2" ]]
mkdir -p "$2"
output="$(cd "$2" && pwd -P)"
(cd "$packet" && /usr/bin/shasum -a 256 -c PAYLOAD-SHA256SUMS) > "$output/payload-admission.log" 2>&1
cp "$packet/PAYLOAD-SHA256SUMS" "$output/"
set +e
/bin/bash --noprofile --norc "$packet/worker.sh" "$1" "$output" 2>&1 | /usr/bin/tee "$output/run.log"
statuses=("${PIPESTATUS[@]}")
set -e
printf 'worker=%s logger=%s\n' "${statuses[0]}" "${statuses[1]}" > "$output/pipeline-status.txt"
code=0
if [[ "${statuses[0]}" != 0 || "${statuses[1]}" != 0 ]]; then
  code=1
  printf '%s\n' 'DIAGNOSTIC_EXECUTION_FAILED_ORIGINAL_QUALIFICATION_STILL_FAILED' > "$output/STATUS.txt"
else
  python3 "$packet/analyze_refs.py" "$output/admitted-inputs" "$output/native" > "$output/analysis.log" 2>&1 || code=$?
  if [[ "$code" == 0 ]]; then
    printf '%s\n' 'DIAGNOSTIC_COMPLETE_PARENT_REVIEW_REQUIRED_NOT_QUALIFICATION' > "$output/STATUS.txt"
  else
    printf '%s\n' 'DIAGNOSTIC_INCOMPLETE_NO_CAUSAL_ATTRIBUTION_OR_WAIVER' > "$output/STATUS.txt"
  fi
fi
# Foreground worker/tee and analyzer have closed. Hash only after all writers finish.
python3 - "$output" <<'PY'
from pathlib import Path
import sys,hashlib
root=Path(sys.argv[1]);files=sorted(p for p in root.rglob('*') if p.is_file() and p.name!='OUTPUT-SHA256SUMS')
(root/'OUTPUT-SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+str(p.relative_to(root))+'\n' for p in files))
PY
exit "$code"
