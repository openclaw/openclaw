# Session maintenance handoff measurement

## Acceptance rule (registered before measurement)

Use the frozen standard synthetic Gateway workload and observer v3.1.5 on one
pinned source head: stored synthetic account, real loopback WebSocket transport,
14 top-level turns including ten warm turns, a native child, control RPCs,
successful scheduled cron, compaction, five-second settling, 300-second connected
idle, clean shutdown, same-state restart, and clean shutdown. No operator state.

First collect one baseline under load. Attribute each `devicePairing.list`
full-snapshot miss to a cold cache, a pairing mutation, or an unrelated shared-state
write. Pair each `session.maintenance.metadata` request with its preparation.
Unknown causes stay unknown. Stop for a target that does not reproduce.

For maintenance, success means removing each SQL-free no-write metadata request
by returning the completed result, next-age hint and retained age fact through
its existing preparation reply. Expected ceiling: four requests per workload;
SQL unchanged, runtime MAIN zero. Write-capable paths, cancellation, claim release,
age adoption and maintenance cadence must remain unchanged.

Pairing is a separate proposed change and PR, only if existing owner receipts
prove a miss follows an unrelated write. Every real pairing mutation, revocation,
replacement or unknown settlement must invalidate. The connect/admission
authorization check stays at its current effect boundary. An honest zero is valid.

Keep cold, first-turn, warm, cron and restart cells separate. Use three alternating
baseline/candidate count pairs when the first admission has load1 <64 and >=12 GiB
free; otherwise one pair with exact owner attribution. Report SQL, requests and
MAIN median, nearest-rank p95 and min/max, sample counts, per-operation deltas,
and connected-idle rates. One observation is not an estimated tail. Runtime MAIN
must never increase. Investigate every adverse cell; a 20% move is a stop, not
accepted spread. No unmeasured latency or CPU-saving claim.

CPU profiles use the real Gateway with `node --cpu-prof` per thread after counts.
Timing comparisons, if needed, require the campaign timing lock, load1 <24,
serial ABAB with at least five samples per arm on the same platform, cold/warm
separated, and no worse user-facing median or p95. Counts/profile collection does
not claim timing improvements.

## Reproduction

Run the frozen `measure.py --repo <checkout> --sha <head> --out <proof>` with
`--repetitions 1`, default idle/settling, verified frozen hashes, Node >=26.12.1,
`NODE_DISABLE_COMPILE_CACHE=1`, internal temporary/cache roots and the campaign
proof slot. Preserve compact attribution and remove raw synthetic scratch after
verification. Coordinator design approval precedes production edits; database
review and the required owner/static gates precede landing.
