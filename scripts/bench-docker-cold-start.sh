#!/usr/bin/env bash
#
# Benchmark Docker cold start time: measures from `docker run` to HTTP 200.
#
# Usage:
#   bash scripts/bench-docker-cold-start.sh [OPTIONS]
#
# Options:
#   --image <name>      Docker image to benchmark (default: openclaw:local)
#   --runs <n>          Number of runs (default: 5)
#   --endpoint <path>   URL path to poll (default: /)
#   --timeout <secs>    Timeout per run in seconds (default: 60)
#   --json              Output results as JSON only
#   -h, --help          Show this help message

set -euo pipefail

IMAGE="openclaw:local"
RUNS=5
ENDPOINT="/"
TIMEOUT=60
JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)    IMAGE="$2"; shift 2 ;;
    --runs)     RUNS="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --timeout)  TIMEOUT="$2"; shift 2 ;;
    --json)     JSON_OUTPUT=true; shift ;;
    -h|--help)
      head -13 "$0" | tail -12
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if ! command -v docker &>/dev/null; then
  echo "Error: docker is not installed or not in PATH" >&2
  exit 1
fi

timestamp_ms() {
  # Millisecond-precision timestamp
  if date +%s%N &>/dev/null 2>&1; then
    echo $(( $(date +%s%N) / 1000000 ))
  else
    # macOS fallback using python
    python3 -c 'import time; print(int(time.time() * 1000))'
  fi
}

run_single() {
  local run_num="$1"
  local host_port
  host_port=$(shuf -i 30000-39999 -n 1 2>/dev/null || python3 -c 'import random; print(random.randint(30000,39999))')
  local container_name="openclaw-bench-${run_num}-$$"

  local start_ms
  start_ms=$(timestamp_ms)

  docker run -d --rm \
    --name "$container_name" \
    -p "${host_port}:18789" \
    -e OPENCLAW_NO_RESPAWN=1 \
    -e OPENCLAW_DISABLE_BONJOUR=1 \
    -e OPENCLAW_SKIP_CANVAS_HOST=1 \
    "$IMAGE" \
    node --disable-warning=ExperimentalWarning openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789 \
    >/dev/null 2>&1

  local url="http://localhost:${host_port}${ENDPOINT}"
  local deadline_ms=$(( start_ms + TIMEOUT * 1000 ))
  local ok=false

  while true; do
    local now_ms
    now_ms=$(timestamp_ms)
    if (( now_ms >= deadline_ms )); then
      break
    fi
    if curl -sf -o /dev/null "$url" 2>/dev/null; then
      ok=true
      break
    fi
    sleep 0.05
  done

  local end_ms
  end_ms=$(timestamp_ms)
  local elapsed_ms=$(( end_ms - start_ms ))

  docker rm -f "$container_name" >/dev/null 2>&1 || true

  if ! $ok; then
    echo "TIMEOUT" >&2
    return 1
  fi

  echo "$elapsed_ms"
}

if ! $JSON_OUTPUT; then
  echo "=== Docker Cold Start Benchmark ==="
  echo "Image:    $IMAGE"
  echo "Runs:     $RUNS"
  echo "Endpoint: $ENDPOINT"
  echo "Timeout:  ${TIMEOUT}s"
  echo ""
fi

times=()
failures=0

for i in $(seq 1 "$RUNS"); do
  if ! $JSON_OUTPUT; then
    printf "Run %d/%d ... " "$i" "$RUNS"
  fi
  result=$(run_single "$i" 2>&1) || true
  if [[ "$result" == "TIMEOUT" ]]; then
    if ! $JSON_OUTPUT; then
      echo "TIMEOUT (${TIMEOUT}s)"
    fi
    failures=$(( failures + 1 ))
  else
    if ! $JSON_OUTPUT; then
      echo "${result}ms"
    fi
    times+=("$result")
  fi
done

if [[ ${#times[@]} -eq 0 ]]; then
  echo "All runs timed out." >&2
  exit 1
fi

# Sort times for median calculation
IFS=$'\n' sorted=($(sort -n <<<"${times[*]}")); unset IFS

count=${#sorted[@]}
min=${sorted[0]}
max=${sorted[$((count - 1))]}

# Mean
sum=0
for t in "${sorted[@]}"; do
  sum=$(( sum + t ))
done
mean=$(( sum / count ))

# Median
if (( count % 2 == 1 )); then
  median=${sorted[$((count / 2))]}
else
  mid=$(( count / 2 ))
  median=$(( (sorted[mid - 1] + sorted[mid]) / 2 ))
fi

if $JSON_OUTPUT; then
  printf '{"image":"%s","runs":%d,"endpoint":"%s","failures":%d,"times":[%s],"min":%d,"max":%d,"mean":%d,"median":%d}\n' \
    "$IMAGE" "$RUNS" "$ENDPOINT" "$failures" \
    "$(IFS=,; echo "${sorted[*]}")" \
    "$min" "$max" "$mean" "$median"
else
  echo ""
  echo "=== Results ==="
  printf "%-10s %s\n" "Min:" "${min}ms"
  printf "%-10s %s\n" "Max:" "${max}ms"
  printf "%-10s %s\n" "Mean:" "${mean}ms"
  printf "%-10s %s\n" "Median:" "${median}ms"
  printf "%-10s %d/%d\n" "Success:" "$count" "$RUNS"
  if (( failures > 0 )); then
    printf "%-10s %d\n" "Timeouts:" "$failures"
  fi
fi
