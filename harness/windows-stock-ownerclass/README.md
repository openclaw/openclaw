# Stock d38 owner-class qualification packet

Prepared only. No dispatch, stock test result, product edit, commit or push is included.
Parent review is required before one initial GitHub-hosted windows-2025 execution.

## Assembly by parent

Copy this packet's Invoke-StockOwnerClass.ps1, stock-inputs.json, original-order.json,
SHA256SUMS, workflow-stock-ownerclass.yml and README.md byte-for-byte to harness/windows-stock-ownerclass/ in the
parent-owned proof harness checkout. Copy workflow-stock-ownerclass.yml to a dedicated
.github/workflows/ workflow. Static/review records remain evidence, not source overlays.
Recheck the final assembled workflow with the same source pins before authorizing it.
The workflow checks out its own harness ref and separately checks out immutable stock
openclaw/openclaw-windows-node d38ebb418c3aba6b24a4d6470def72b2bba4c4a8.
The parent records the exact assembled harness head and owns any future publication
or dispatch. This child has performed neither.

The workflow accepts only the explicit stock-d38-ownerclass-once acknowledgement,
refuses workflow reruns (run_attempt != 1), uses read-only permissions, persists no
checkout credentials, and has no secrets, installs beyond the already-authorized
exact .NET SDK setup, UI runtime, cache, production overlay, release or deploy step.
Autocrlf is disabled only through the two checkout steps' process environment;
there is no global/repository Git configuration mutation. Raw Git blob admission
checks all 2,090 source files before and after execution, not merely Git status.

## Exact one-run command boundary

SDK: 10.0.403; framework: net10.0; architecture: native Windows x64.
Stock restore and Debug build use the normal Shared.Tests project and dependencies.
No full ./build.ps1, Tray suite, original native15, W3 or UI capture is repeated.

The test command is the stock scripts/Invoke-CiTest.ps1 owner with Project
 tests/OpenClaw.Shared.Tests, one fresh ResultsDirectory/TrxFileName, and Filter
 FullyQualifiedName~OpenClaw.Shared.Tests.ExecApprovalsStoreTests.
The helper runs its normal --no-build Debug VSTest invocation and retains the
source-owned test/pass-admission contract. There is no worker count, seed,
order override, retry, hang timer, sleep, coverage mode, ACL or policy change.
The test step retains the canonical core-tests 15-minute outer CI budget.

Original run 41491349646 artifact 13165785850 was 3,098,148 bytes, SHA256
7dfc0089c310ad1462d95d261042a1377c33ba81ed8bc5ffa20ae61dbdf9d430.
original-order.json retains the 98 original class rows ordered by actual start/end;
there were no tied starts or overlapping intervals in those original rows.
The failing case is ordinal74, Changed_ManagedThenExternalEvents_HaveMonotonicSequences.
Its original HResult and actual blocking handle were not captured.

## Admission and evidence

The runner requires a fresh output directory, exact source head/tree/raw bytes and
16 explicit owner/build/helper SHA256 pins, exact SDK, all 98 original unique case
identities executed without skips, a single fresh TRX, fresh case timestamps,
consistent counts, declared VSTest container path and matching TRX storage, and
unchanged full built test-output/dependency inventory before/after test execution.
A successful exit additionally goes through stock Read-TestResultContract without
AllowSkipped. Failed TRX parsing is diagnostic only; it never grants a passing gate.
The HResult field is null unless the unchanged failure message explicitly contains it.
No exception wrapper, debugger, native driver or in-process probe is injected.

Outputs retain original test console/TRX, restore/build commands/logs, exact current
SDK/runtime/OS/image/run metadata, all source and binary SHA256s, runtimeconfig/deps/
project.assets hashes, actual chronological case order and outcomes, full-order and
prefix-through-ordinal74 comparison, first differing ordinal, original error text,
and an output artifact hash inventory. The driver never fetches credentials or
reads normal user configuration; a state override or coverage request is refused.

## Interpretation: original Shared gate always RED/unwaived

- NONCOMPARABLE_ORDER: the case order differs anywhere, or tied/overlapping
  same-class timestamps make it ambiguous. The prefix comparison is still recorded.
  Exit1. Do not patch order, seed or retry to get a preferred result.
- NONREPRODUCTION_ONLY: all98 pass through the strict canonical contract and
  actual order matches. Exit0 describes only this qualification command, not W4
  validation, a fix, inherited-only attribution or a cleared Shared gate.
- STOCK_CLASS_FAILURE_OBSERVED: same full order and the original case's
  UnauthorizedAccessException/WriteAtomically:1823 signature is observed. Exit1.
  This supports a stock-source reproduction, not proof of the original blocking
  handle or a fix. Other failures are retained too.
- DIFFERENT_STOCK_CLASS_FAILURE: same order but a different failure. Exit1.
- INPUT_OR_EXECUTION_FAILURE: unavailable inputs, identities, freshness, build,
  binding or result admission. Exit1; no stock conclusion.

A pass cannot fix, replace or erase the original failure. Even a same-order stock
failure is a bounded causal-attribution observation, not a complete root cause.
Class filtering omits original cross-class interleaving and preceding native/full
build workload. Current host load, image, build metadata and runtime patch can differ.
Original loaded BCL/Shared binary identities were not retained. The declared container,
TRX storage, deps and before/after hashes bind this run's build outputs but are NOT an
in-process loaded-module trace. No actual blocking handle is identified by this packet.

W4 stays frozen at uncommitted tree eab5a16b2c6b57a741c7a1a22f830f737592d1ee,
HEAD/base d38ebb418c3aba6b24a4d6470def72b2bba4c4a8, exactly ten product files.
The successful current W4 native15, seven frames, full build and Tray results remain
separate evidence. Shared's original 4808 passed/1 failed/25 per-case skipped remains
RED/unwaived; its Counters.notExecuted=0 is not rewritten to hide the 25 skipped rows.
No silent CI exception or merge/release authorization is supplied here.
