#!/usr/bin/env bash
# bench-help-fast-path.sh — 可重复的 CLI help 性能基准测试
# 用法: ./scripts/bench-help-fast-path.sh [运行次数]
set -euo pipefail

RUNS="${1:-5}"
OPENCLAW="${OPENCLAW:-openclaw}"
COMMANDS=("memory --help" "plugins --help" "pairing --help")

echo "=== OpenClaw CLI Help Benchmark ==="
echo "Binary: $(which $OPENCLAW)"
echo "Runs per command: $RUNS"
echo "Warmup: 1 run (discarded)"
echo ""

# warmup
for cmd in "${COMMANDS[@]}"; do
  $OPENCLAW $cmd > /dev/null 2>&1 || true
done

for cmd in "${COMMANDS[@]}"; do
  times=()
  for i in $(seq 1 "$RUNS"); do
    start=$(python3 -c "import time; print(time.time())")
    $OPENCLAW $cmd > /dev/null 2>&1 || true
    end=$(python3 -c "import time; print(time.time())")
    elapsed=$(python3 -c "print(f'{$end - $start:.3f}')")
    times+=("$elapsed")
  done
  
  # 计算平均值
  times_csv=$(IFS=,; echo "${times[*]}")
  avg=$(python3 -c "times = [$times_csv]; print(f'{sum(times)/len(times):.3f}')")
  min=$(python3 -c "times = [$times_csv]; print(f'{min(times):.3f}')")
  max=$(python3 -c "times = [$times_csv]; print(f'{max(times):.3f}')")
  
  printf "%-25s  avg=%ss  min=%ss  max=%ss  (raw: %s)\n" \
    "openclaw $cmd" "$avg" "$min" "$max" "${times[*]}"
done

echo ""
echo "=== Done ==="
