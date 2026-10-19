## Unreleased

### Changes

- **Session transcript archive retention:** add `session.maintenance.archiveAfter` (for example `"90d"`) so the historical transcript archive pass bounds per-agent history by age on its normal cadence instead of waiting for disk pressure, and reclaim freed pages after archival (incremental vacuum, or a one-time full `VACUUM` with an `auto_vacuum=INCREMENTAL` retrofit on legacy databases) so archived rows do not leave bloated database files behind.