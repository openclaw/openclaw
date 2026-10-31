# Plugin metadata lease verification

Acceptance rule, recorded before the first run.

Flow: a real isolated Gateway's post-ready `plugin-registry` maintenance with a
synthetic config and derived plugin inventory. Use the frozen campaign v3.1.4
workload, observer and causality instrumentation, pinned to each measured head.
No operator config, state, logs or model credentials are inputs.

Count acquisition, verification, registry publication and release separately.
The baseline attribution is eight `stateLease.verify` requests, two statements
each, per successful refresh. The candidate must use three, removing ten SQL
statements and five requests per refresh. Registry publication, transaction
custody checks, release and runtime MAIN must not increase. Re-run the real
Gateway workload on both heads; failure to reproduce the eight verifies stops
this optimization. Report whole-phase and warm-turn counts separately from the
attributed metadata operations.

Use three alternating baseline/candidate pairs when load is below 64 and at least
12 GiB is free internally, otherwise one pair with explicit source attribution.
Keep cold startup, post-ready maintenance and warm turns separate. Report median,
p95 and min-max for each measured count. CPU profiles cover each Gateway thread.
Use `scripts/bench-gateway-startup.ts --case pluginMetadataMaintenance --runs 1
--warmup 0 --cpu-prof-dir <dir> --output <json>` for the diagnostic profile; this
opt-in case waits for the real post-ready registry refresh to finish.
No wall-clock or CPU A/B claim without the campaign timing lock and load below 24;
if timing is attempted, use at least five interleaved samples per arm. A 20% rise
in any user-facing metric stops landing for attribution and disposition.

The focused regression counts the real worker's verification requests around one
refresh and checks that expiry during configuration preparation cannot publish.
Existing native/worker authority, transaction-custody and PostgreSQL post-ready
conformance tests remain applicable. PostgreSQL review is required before landing.
