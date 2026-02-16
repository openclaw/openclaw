# Feature flags (recommended)

- `CONTROL_PLANE_TEMPORAL_ENABLED` (default: off)
- `TEMPORAL_SHADOW_MODE` (default: on when temporal enabled)
- `DISPATCH_COMMAND_BOUNDARY` (default: on once landed)
- `DISPATCH_POLICY_GATE` (default: off initially; enable per environment)
- `DISPATCH_OUTBOX_WRITE` (default: off initially)
- `OUTBOX_RELAY_MODE` = `off|log|deliver_to_temporal`
- `DISPATCH_EVIDENCE_LIFECYCLE` (default: off initially)
- `DISPATCH_EVIDENCE_PRESIGN` (default: off initially)
- `DISPATCH_TENANCY_COLUMNS` (default: on once migrated)
- `DISPATCH_RLS_ENABLED` (default: off; enable per environment)
- `EDGE_TWILIO_INBOUND` (default: off)
- `EDGE_TWILIO_OUTBOUND` (default: off or dry-run)
