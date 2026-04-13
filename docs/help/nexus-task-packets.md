# Nexus Task Packet Validation

OpenClaw can validate a Nexus task packet locally before any execution begins.

This path is intentionally limited to packet ingest and validation only.
It checks that a packet includes:

- required packet fields
- `authority_level`
- source refs
- `stop_conditions`

It does not execute the packet.

## Usage

```bash
node --import tsx scripts/validate-nexus-task-packet.ts path/to/packet.yaml
```

## Fail-Closed Behavior

- invalid JSON/YAML fails
- missing required fields fail
- missing `authority_level` fails
- missing `source_of_truth_refs` fails
- missing `stop_conditions` fails

If packet shape or approval boundary is ambiguous, do not execute it in OpenClaw.
