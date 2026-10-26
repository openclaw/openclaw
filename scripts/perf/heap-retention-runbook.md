# Capture and analyze retained heap

Use a main-isolate heap snapshot to identify structures that keep memory alive.
The [diagnostics guide](../../docs/gateway/diagnostics.md#full-heap-snapshot)
owns the capture contract. This runbook covers capture coordination, isolated
validation, bounded analysis, and handling sensitive artifacts.

## Capture during an approved maintenance window

The deployment operator schedules the capture immediately before a planned
restart, when a main-thread pause is acceptable. Analysis preparation does not
authorize capturing or restarting a production Gateway. Stop other profilers and
debuggers first; the RPC rejects known overlapping instrumentation.

Budget **tens of seconds of unresponsiveness** for a snapshot around 3 GB, rather
than assuming a brief pause. V8 can need roughly twice the heap's memory during
capture. Check available memory and free space on the actual state filesystem;
for an expected 2–4 GB snapshot, reserve at least 8 GB of free disk as an operator
planning allowance, plus any space required for existing artifacts. Neither the
RPC timeout nor its heap admission limit caps native capture memory, duration,
or output size. Reassess the allowance if the live heap has grown.

From the operator's existing authenticated CLI environment, run once:

```bash
openclaw gateway call diagnostics.heapSnapshot \
  --params '{"reason":"retention analysis before planned restart"}' \
  --timeout 180000 --json
```

The method requires `operator.admin` and accepts only an optional `reason` of at
most 256 characters. It writes an owner-only file named
`<state>/diagnostics/heap-<timestamp>.heapsnapshot`; callers cannot choose an
output path. The response contains `path`, `sizeBytes`, `heapUsedBefore`,
`heapUsedAfter`, and `elapsedMs`. Record those numbers with the Gateway revision,
runtime version, uptime, session population, and workload phase. Worker isolates
and external/native memory are outside this snapshot.

A timeout or lost connection **does not cancel** `writeHeapSnapshot()`. Inspect
the diagnostics directory and capture logs before attempting another request.
The owner enforces a 60-second cooldown after native capture finishes. It
releases the inspector's snapshot metadata and object-ID tracking afterward;
standalone captures therefore have independent object IDs. A planned restart
remains the deployment operator's responsibility.

## Validate with synthetic state

Use the existing [team-shape fixture](README.md) in a prepared source checkout.
Choose an unused loopback port at or above 40000 and a new absolute state path.
The small fixture below tests the capture and analysis path; it is not a
production-sized retention baseline.

```bash
node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
  --state-dir /path/to/new-synthetic-state \
  --sessions 100 --runs 0 --approvals 0 --cron 0 --projects 0 \
  --transcript-mib 0 --port 41667 --launch
```

The launcher supplies isolated home, state, config, temporary files, and service
identity; its Gateway binds to loopback with authentication disabled. Keep that
process running. In a second terminal in the same checkout, set only the
synthetic paths for the client and require the expected destination:

```bash
HEAP_FIXTURE=/path/to/new-synthetic-state
HOME="$HEAP_FIXTURE/home" \
OPENCLAW_HOME="$HEAP_FIXTURE/home" \
OPENCLAW_STATE_DIR="$HEAP_FIXTURE" \
OPENCLAW_CONFIG_PATH="$HEAP_FIXTURE/openclaw.json" \
TMPDIR="$HEAP_FIXTURE/tmp" \
pnpm openclaw gateway call diagnostics.heapSnapshot \
  --port 41667 --expect-url ws://127.0.0.1:41667 \
  --params '{"reason":"synthetic retention validation"}' \
  --timeout 180000 --json
```

Stop only the fixture launcher after capture. Analyze the returned path and
check the known-dominator tests before handling a production snapshot. Keep
fixture generation and Gateway execution on the host permitted by the current
campaign's compute rules.

## Analyze without exporting snapshot contents

Snapshots are unredacted: they can contain messages, credentials, prompts, file
paths, and source text. Keep production snapshots on their source host unless the
operator explicitly approves a particular transfer and destination. Do not
upload them to a public artifact service or attach them to a PR. Preserve files
that another analysis is using; analysis opens the input read-only.

For one snapshot, request aggregate retention output:

```bash
umask 077
node scripts/heap-snapshot-diff.mjs --summary /path/to/capture.heapsnapshot \
  --top 30 > /path/to/private-evidence/retention-summary.json
```

This mode writes JSON with constructor totals and owner-path clues, duplicate-string byte
counts, and top-collection summaries without string values. By default, only
fixed built-in labels are printed; other snapshot labels stay hidden. An optional
`--labels /path/to/reviewed-labels.txt` accepts newline-separated identifiers
reviewed against source code, allowing specific class, closure, or property names
to appear. Never construct that allowlist from unreviewed snapshot strings.
Do not substitute the ordinary two-file diff: its object labels and retaining paths are sensitive.
Review the generated schema and output before exporting aggregates.

### Attribute compiled code to scripts

Use the aggregate-only code mode to rank compiled scripts and detect repeated
compilation identities:

```bash
node scripts/heap-snapshot-diff.mjs --code-by-script /path/to/capture.heapsnapshot \
  --script-allowlist /path/to/reviewed-build-files.txt --top 30 \
  > /path/to/private-evidence/code-summary.json
```

`--code-by-script` implies `--summary`; the same on-host isolation and pressure
guards below apply. Its output contains only aggregate counts/bytes and reviewed
script names. Build the separate newline-separated script allowlist from the
**deployed build's file listing**, including JavaScript files in `dist` and
package-relative JavaScript paths in deployed `node_modules`. Review the listing
before use; exclude user state, home directories, and symlinks outside the product
build. List each approved absolute path, file URL, or package-relative spelling
explicitly. Matching is exact after removing the snapshot name's query/hash:
there are no prefix, basename, URL-decoding, or realpath matches. Never derive
this allowlist from snapshot strings. Without an allowlist, all names are redacted.
List the release that produced the snapshot, not the current symlink: after a
deploy, `current` resolves to a newer release directory and every name redacts.

`topScripts` ranks retained bytes; `duplicateScripts` includes **every** complete
normalized identity with multiple reachable V8 Script objects, regardless of
`--top`. HMAC-SHA-256 values keyed per run distinguish redacted names within one
report without emitting them; they cannot confirm a guessed path or link runs. Empty
and truncated names have null hashes and remain separate; match `--string-limit`
to the capturing runtime. Instance counts measure compiled Script objects, not
functions or proof of repeated module evaluation. Intentional VM/plugin isolation
and query-busted imports can both create multiple instances; inspect the loader
before treating duplication as waste.

Attribution follows Node/V8's Script and SharedFunctionInfo links, closure
code/feedback links, and strong internal/hidden edges between code nodes. Script
and function-info seeds stay fixed. Conflicting script associations and tagged
runtime builtins go to `sharedOrRuntime`; code with no known association goes to
`unattributed`. This is an inferred association, not an exclusive ownership proof.
`shallowBytes` partitions reachable code nodes once. `retainedBytes` is the union
of each group's dominated subtrees, including source strings and non-code data;
nested code in the same group counts once, but **different rows can overlap**.
The `total` row unions all reachable code subtrees independently. Do not sum
retained rows or equate them with `v8.getHeapCodeStatistics()` or expected savings.

`duplicateStringRetainers` ranks excess shallow bytes by a representative direct
retainer constructor/property and its nearest context or named-constructor
dominator. It keeps the first largest copy of each complete string and charges
every other physical node once. Multiple incoming references do not multiply
the bytes; `multipleIncomingCopies` flags that ambiguity. This is an attribution
clue, not proof that changing that producer can reclaim the entire row. Shared
values may remain live elsewhere. `attributedBytes` includes groups outside the
top-N output; `unattributedBytes` accounts for nodes with no reachable strong
incoming edge. Both sum to the duplicate estimate.

The report includes safe paths for each displayed group's owner and an example
retainer. Follow reviewed code identifiers back to source before assigning a
module. Use `--node ID` to inspect a snapshot-local owner's immediate children;
`inspectedNodes` prints only allowlisted labels, retained bytes and outgoing
element-reference counts. The latter can count a sample array's populated
entries, but is neither array length nor Map size. No payload strings are printed.
JavaScript string equality compares values, so it cannot prove physical sharing;
validate string-sharing changes with synthetic heap-node/byte counts instead.

On a shared Linux host, run the analyzer in a dedicated systemd scope with an
explicit memory bound, no swap, and low CPU/I/O priority. Choose approved CPUs
for that host. For example:

The following supervisor checks pressure before starting, polls every two
seconds, and stops the analysis process group on pressure, interruption, or a
monitoring failure. It writes a new private output file and removes that partial
output if analysis fails. Replace the paths and CPU allocation for the approved
host; the output directory must already exist.

```bash
umask 077
systemd-run --scope --quiet \
  -p AllowedCPUs=0-63 -p CPUWeight=10 -p IOWeight=10 \
  -p MemoryMax=24G -p MemorySwapMax=0 \
  nice -n 19 ionice -c3 \
  python3 - /path/to/capture.heapsnapshot /path/to/private-evidence/retention-summary.json <<'PYTHON'
from contextlib import suppress
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

snapshot, output = sys.argv[1:]

def check_pressure():
    lines = Path("/proc/pressure/memory").read_text().splitlines()
    some = next(line for line in lines if line.startswith("some "))
    metrics = dict(field.split("=", 1) for field in some.split()[1:])
    if float(metrics["avg10"]) > 10:
        raise RuntimeError("Analysis aborted: memory PSI some avg10 exceeds 10")

def interrupted(signum, frame):
    raise InterruptedError("Analysis interrupted")

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
check_pressure()
process = None
created = False
complete = False
try:
    with open(output, "x") as destination:
        created = True
        os.chmod(output, 0o600)
        process = subprocess.Popen(
            ["node", "scripts/heap-snapshot-diff.mjs", "--summary", snapshot, "--top", "30"],
            stdout=destination,
            start_new_session=True,
        )
        while process.poll() is None:
            check_pressure()
            time.sleep(2)
        if process.returncode != 0:
            raise RuntimeError("Analysis failed; no valid report")
        complete = True
finally:
    if process is not None and process.poll() is None:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    if created and not complete:
        Path(output).unlink(missing_ok=True)
PYTHON
```

The cgroup limit is a backstop, not a reason to continue under host pressure.
A PSI abort or memory-limit failure produces no valid report; preserve the input
and retry only when the host is healthy. If the kernel kills the supervisor, its
cleanup cannot run: discard any partial output and require a successful command
exit before accepting a report. Do not run concurrent full-graph analyses merely
to finish sooner.

Copy only inspected aggregate JSON/text to the approved evidence directory:

```bash
scp analysis-host:/path/to/private-evidence/retention-summary.json \
  /path/to/approved-evidence/retention-summary.json
```

For a synthetic snapshot, or a separately approved production transfer, `scp`
can copy the snapshot to a private directory on an operator-controlled machine.
The source-host-only restriction takes precedence when it applies. Delete
sensitive snapshots after analysis only when their owner authorizes cleanup and
all readers have finished; successful captures have no automatic retention job.

## Interpret the result

Retained size belongs to a dominator: removing it disconnects its dominated
subtree from the modeled strong roots. Constructor totals must not double-count
nested instances of that constructor, but totals for different constructors can
overlap. Do not sum every row into a new heap total. A large shared object can
have a root dominator even when many sessions reference it.

The analyzer excludes weak and shortcut edges and summarizes a strong-edge
graph; V8 ephemeron semantics and DevTools attribution can differ. Constructor,
closure, and property names provide ownership clues, not proof of a source
module. Follow them back to the owning code before proposing a fix. Session-key
counts describe recognized key shapes, not necessarily unique active sessions;
state the denominator when reporting bytes per session. Duplicate-string totals exclude names at or above the capturing runtime's
string truncation limit: V8 can serialize different long strings with the same
prefix. `--string-limit N` must match that runtime setting (default 1024 in
Node 26.12.1); the report counts excluded groups separately. These totals
are potential shallow-byte savings, not a promise that every duplicate can be
interned without changing lifetime or behavior.

Compare snapshots only when runtime, workload phase, and session populations
are known. A dev Gateway seed can suggest an owner to inspect, but cannot
establish its share of a production heap or predict GC savings by itself.
