# Incident Dossier Template

Use for durable, searchable incident memory. Keep it short. Prefer exact evidence over prose.

## Title

- Service:
- Date:
- Env:
- Severity:

## Summary

- What broke:
- Customer impact:
- Detection:
- Resolution:

## Fingerprints

- Alerts:
- Log lines:
- Metrics:
- Traces:
- Data / DB evidence:
- Argo / deploy signals:

## Scope

- Services:
- Namespaces:
- Workloads:
- Dependencies:
- DB targets:
- DB routing / topology:

## Data / DB Evidence

- Schema probe:
- Business-data query:
- PG internals:
- Replica / replay facts:
- Query-pressure facts:

## Likely Cause

- Primary:
- Contributing:
- Ruled out:
- Disproved theories:

## Fix

- Immediate mitigation:
- Rollback:
- Permanent fix:

## Validation

- Checks:
- Expected recovery signal:

## Prevention

- Missing alerts:
- Missing guardrails:
- Needed runbook/checklist:
- Needed DB checks / topology checks:

## References

- PRs:
- Linear:
- Slack thread:
- Source docs/postmortem:
