# Incident Dossier: openclaw-sre relationship-index OOM

## Title

- Service: openclaw-sre
- Date: 2026-03-16
- Env: morpho-prd
- Severity: warning

## Summary

- What broke: openclaw-sre pod OOMKilled due to a hot retry loop in the relationship-index plugin caused by a truncated state file.
- Customer impact: No confirmed customer impact. Internal observability degraded.
- Detection: BetterStack alerts `940048931` (high memory) + `940048394` (high CPU) at 17:58-17:59 UTC.
- Resolution: Pod self-recovered after OOM restart (exit=137, restarts=1). Error loop continued until state file repaired. `relationshipIndex.enabled` set to `false` in config.

## Fingerprints

- Alerts: `MorphoHighMemoryUsageAlert`, `MorphoHighCPUUsageAlert` for `deployment/openclaw-sre` in namespace `monitoring`
- Log lines: `[relationship-index] failed to persist graph update: SyntaxError: Unterminated string in JSON at position 1048576`
- Metrics: Memory peaked ~3.6 GiB (30m), CPU peaked ~1.47 cores (30m); current 15m avg ~0.85 cores, ~1.1 GiB
- Traces: N/A
- Data / DB evidence: `latest-by-entity.json` truncated at exactly 1,048,576 bytes (1 MiB boundary), file timestamp 2026-03-13T14:16:14Z
- Argo / deploy signals: Not checked

## Scope

- Services: openclaw-sre gateway (heartbeat, incident automation, Slack socket)
- Namespaces: monitoring
- Workloads: deployment/openclaw-sre (pod openclaw-sre-866947c478-qvswl)
- Dependencies: PVC-backed state directory `/home/node/.openclaw/state/sre-graph/`
- DB targets: N/A (local file-based state)
- DB routing / topology: N/A

## Data / DB Evidence

- Schema probe: N/A
- Business-data query: `wc -c /home/node/.openclaw/state/sre-graph/latest-by-entity.json` = `1048576` (exact 1 MiB truncation)
- PG internals: N/A
- Replica / replay facts: N/A
- Query-pressure facts: N/A

## Likely Cause

- Primary: `latest-by-entity.json` truncated at 1 MiB boundary (write interrupted, possibly by prior OOM or filesystem flush failure on 2026-03-13). Every compaction attempt rereads the file and hits `SyntaxError`, causing a hot retry loop that amplifies CPU/memory until OOM.
- Contributing: No atomic write (temp file + rename) for state snapshots, so partial writes survive pod restarts.
- Ruled out: `edges.ndjson` corruption was initially hypothesized in the Slack thread but contradicted by the Linear ticket's deeper analysis showing `latest-by-entity.json` as the truncated file.
- Disproved theories: "edges.ndjson corrupt at line 1614" — the Slack message's hypothesis was inconsistent with the file-level evidence in the Linear ticket.

## Fix

- Immediate mitigation: Quarantine/rename corrupt `latest-by-entity.json`, or disable `relationshipIndex` feature flag in Helm values.
- Rollback: Restore prior `latest-by-entity.json` from backup or re-enable feature flag.
- Permanent fix: (1) Tolerate truncated/invalid `latest-by-entity.json` by quarantining and rebuilding from `nodes.ndjson`. (2) Write snapshots via temp file + atomic rename to prevent partial writes surviving crashes.

## Validation

- Checks: relationship-index warning count drops to 0, no new `OOMKilled` terminations, memory stays below alert threshold for one full alert window, websocket probe succeeds.
- Expected recovery signal: `kubectl -n monitoring logs deploy/openclaw-sre --since=10m | grep -c 'relationship-index'` returns 0.

## Prevention

- Missing alerts: No alert for relationship-index error rate (hot retry loop detection).
- Missing guardrails: No atomic write for state snapshots. No file integrity check on startup.
- Needed runbook/checklist: Startup validation of state files in `sre-graph/` directory — detect truncation at power-of-2 boundaries and auto-quarantine.
- Needed DB checks / topology checks: N/A

## References

- PRs: Suggested `fix(relationship-index): tolerate malformed ndjson during compaction` + `fix(relationship-index): write snapshot via temp file + atomic rename` on branch `feature/pla-834-repair-openclaw-sre-relationship-index-corruption-loop`
- Linear: PLA-834
- Slack thread: https://morpholabs.slack.com/archives/C0A3T6VVCPQ/p1773684167648719
- Source docs/postmortem: N/A
