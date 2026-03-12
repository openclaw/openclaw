---
name: go-memory-profiling
description: Debug Go application OOM and memory issues using pprof heap profiling, Prometheus metrics, and Kubernetes tooling. Use when investigating OOMKilled pods, memory leaks, high allocation rates, or Go runtime memory behavior. Triggers on "OOM", "memory leak", "heap profile", "pprof", "memory spike", "Go memory".
---

# Go Memory Profiling & OOM Debugging

Systematic approach to debugging Go application memory issues in Kubernetes environments.

## Quick Reference

Requirements:

- Go toolchain with `go tool pprof`, or a standalone `pprof` binary on PATH.

```bash
# Get heap profile from pod with pprof
kubectl port-forward -n $NS pod/$POD 16060:6060 &
curl -s http://localhost:16060/debug/pprof/heap > heap.prof
go tool pprof -text -inuse_space heap.prof | head -30

# Key Go memory metrics from Prometheus
curl -s http://localhost:$METRICS_PORT/metrics | grep "^go_memstats_"
```

## Instructions

### Phase 1: Triage - Confirm OOM and Gather Context

1. **Check pod status and termination reason:**

   ```bash
   kubectl get pods -n $NS -l $LABELS -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{range .status.containerStatuses[*]}{.restartCount}{" "}{.lastState.terminated.reason}{" "}{.lastState.terminated.exitCode}{end}{"\n"}{end}'
   ```

2. **Verify OOM vs other exit 137 causes** (exit 137 = SIGKILL, NOT always OOM):
   - OOMKilled: `kubectl describe pod $POD -n $NS | grep -A5 "Last State"`
   - Liveness probe failure: Check events for probe failures
   - Disk full: `df -h` inside container
   - Node eviction: Check node conditions

3. **Check resource limits:**

   ```bash
   kubectl get deploy $DEPLOY -n $NS -o jsonpath='{.spec.template.spec.containers[0].resources}'
   ```

4. **Check Go memory env vars:**
   ```bash
   kubectl get deploy $DEPLOY -n $NS -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' | grep -E "GOMEMLIMIT|GOGC|GODEBUG"
   ```

### Phase 2: Metrics Analysis

5. **Get Go runtime memory metrics** (port-forward to metrics endpoint):

   ```bash
   kubectl port-forward -n $NS pod/$POD $LOCAL_PORT:$METRICS_PORT &
   curl -s http://localhost:$LOCAL_PORT/metrics | grep "^go_memstats_"
   ```

   **Key metrics to compare between healthy and unhealthy pods:**
   | Metric | Meaning | Healthy Signal |
   |--------|---------|----------------|
   | `go_memstats_heap_alloc_bytes` | Live heap objects | Should be << container limit |
   | `go_memstats_heap_sys_bytes` | Virtual memory reserved | Can be >> alloc (normal) |
   | `go_memstats_alloc_bytes_total` | Cumulative allocations | High = allocation pressure |
   | `go_memstats_heap_objects` | Live object count | Spike = retention issue |
   | `go_gc_duration_seconds{quantile="1"}` | Worst-case GC pause | >100ms = GC pressure |
   | `go_gc_gomemlimit_bytes` | Soft memory limit | Go 1.22+; should match GOMEMLIMIT when exported |

6. **Compare pods** - if some pods are healthy and others aren't with same config, the issue is traffic-dependent, not config-dependent.

7. **Check allocation rate** via Prometheus/Thanos:
   ```promql
   rate(go_memstats_alloc_bytes_total{pod=~"$POD_PATTERN"}[5m]) / 1024 / 1024 / 1024
   ```

### Phase 3: Heap Profiling with pprof

8. **Enable pprof** if not already available:

   **Option A - Binary already in image (common pattern):**

   ```bash
   # Check if pprof binary exists
   kubectl get deploy $DEPLOY -n $NS -o jsonpath='{.spec.template.spec.containers[0].image}'
   # Patch command to use pprof binary
   kubectl patch deploy $DEPLOY -n $NS --type='json' \
     -p='[{"op":"add","path":"/spec/template/spec/containers/0/command","value":["/app-pprof"]}]'
   ```

   **Option B - Add net/http/pprof import:**
   Add `import _ "net/http/pprof"` and start HTTP server on port 6060.

9. **Capture heap profile** when memory is elevated:

   ```bash
   kubectl port-forward -n $NS pod/$POD 16060:6060 &
   sleep 2

   # Verify pprof is accessible
   curl -s http://localhost:16060/debug/pprof/ | head -5

   # Download heap profile
   curl -s http://localhost:16060/debug/pprof/heap > heap.prof
   ```

10. **Analyze the profile:**

    ```bash
    # What's currently retained in memory (most important)
    go tool pprof -text -inuse_space heap.prof | head -30

    # Total allocations over lifetime (shows allocation hotspots)
    go tool pprof -text -alloc_space heap.prof | head -30

    # Live object count (helps identify retention vs allocation)
    go tool pprof -text -inuse_objects heap.prof | head -20

    # Interactive mode with flame graph
    go tool pprof -http=:8080 heap.prof
    ```

### Phase 4: Interpret Results

11. **Common OOM patterns and their pprof signatures:**

    | Pattern                  | inuse_space              | alloc_space        | Root Cause                                 |
    | ------------------------ | ------------------------ | ------------------ | ------------------------------------------ |
    | Retention leak           | High single function     | Normal             | Objects held by long-lived references      |
    | Allocation storm         | Normal                   | Very high          | Rapid alloc/free cycling, GC can't keep up |
    | Response buffering       | High in io/bytes         | High in io.ReadAll | Full responses read into memory            |
    | Clone/copy amplification | High in Clone/copy       | High               | Deep copies of large objects               |
    | Cache unbounded          | High in cache Set        | Normal             | In-memory cache without eviction           |
    | Goroutine leak           | Spread across goroutines | Normal             | Goroutines holding references              |

12. **Key questions for diagnosis:**
    - Is `inuse_space` dominated by one function? → That function retains too much
    - Is `alloc_space` >> `inuse_space`? → High churn, GC pressure
    - Does `heap_objects` grow over time? → Object retention leak
    - Is `heap_sys_bytes` >> `heap_alloc_bytes`? → Memory fragmentation

### Phase 5: Common Fixes

13. **Config-level mitigations** (no code change):
    - Reduce concurrency settings (e.g., split concurrency, batch sizes)
    - Reduce max allowed ranges/sizes for operations
    - Set appropriate GOMEMLIMIT (70-80% of container limit)
    - Tune GOGC (lower = more frequent GC but less peak memory)

14. **Code-level fixes:**
    - Replace `io.ReadAll` with streaming or pooled buffers (`sync.Pool`)
    - Avoid deep Clone/Copy - use reference counting or COW
    - Add semaphores to limit concurrent memory-heavy operations
    - Use `bytes.Buffer` pools for repeated serialization
    - Release references early (set to nil after use, but verify no later access)

15. **Verify the fix:**
    ```bash
    # Take before/after heap profiles
    # Compare inuse_space totals and top allocators
    go tool pprof -text -inuse_space before.prof | head -10
    go tool pprof -text -inuse_space after.prof | head -10
    ```

## Go Memory Model Reference

```
Container Memory (cgroup limit) ← OOMKill happens here
  └── Process RSS (Resident Set Size)
        └── Go heap_sys (virtual memory reserved by Go runtime)
              └── Go heap_alloc (live objects on heap)
                    └── heap_inuse (spans with at least one object)

GOMEMLIMIT → soft target for heap_alloc (Go GC tries to stay under)
GOGC → triggers GC when heap grows by this % over previous live heap
```

**GOMEMLIMIT + GOGC interaction:**

- GOGC=100 (default): GC triggers at 2x live heap
- GOGC=25: GC triggers at 1.25x live heap (more frequent, less peak)
- GOMEMLIMIT: Overrides GOGC when approaching the limit (GC runs more aggressively)
- Set GOMEMLIMIT to ~70-80% of container limit to leave room for non-heap memory

## Prometheus Metric Cardinality Check

High metric cardinality can itself cause memory issues:

```bash
# Count total time series
curl -s http://localhost:$METRICS_PORT/metrics | grep -cv "^#\|^$"

# Top metrics by series count
curl -s http://localhost:$METRICS_PORT/metrics | grep -v "^#" | grep -v "^$" | sed 's/{.*//' | sort | uniq -c | sort -rn | head -15

# Check for unbounded label dimensions
curl -s http://localhost:$METRICS_PORT/metrics | grep -v '^#' | grep -oP '[a-zA-Z_][a-zA-Z0-9_]*(?==")' | sort -u | wc -l
```

Rule of thumb: >50K time series per pod starts to matter; >200K is a problem.

## Checklist

- [ ] Confirm OOM (not liveness probe, disk full, or eviction)
- [ ] Check GOMEMLIMIT and GOGC settings
- [ ] Compare healthy vs unhealthy pods (same traffic? same memory?)
- [ ] Get Go runtime metrics from /metrics endpoint
- [ ] Enable pprof if not available
- [ ] Capture heap profile when memory is elevated
- [ ] Analyze inuse_space (what's retained)
- [ ] Analyze alloc_space (what's allocated total)
- [ ] Identify top allocator function(s)
- [ ] Determine pattern (retention, allocation storm, buffering, etc.)
- [ ] Apply fix (config or code level)
- [ ] Verify with before/after heap profiles
