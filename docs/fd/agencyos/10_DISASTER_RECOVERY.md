# 10 — Disaster Recovery Plan

## Recovery Levels

### Level 1 — Human Error (Accidental Deletion)

**Scenario:** Team member accidentally deletes a Notion database, property, or page.

**Mitigation:**
- Enable Notion Page History (all plans)
- Weekly workspace export (Notion Settings → Export)
- Trello backup via API dump (scheduled job)
- Stripe backup automatic (event log retained 30 days)
- QuickBooks backup automatic

**OpenClaw Response:**
1. Detect missing database via scheduled compliance check
2. Attempt auto-recreate from YAML manifest (if healable)
3. Restore last known schema from `system_snapshots`
4. Alert via health endpoint warning

**Recovery Steps:**
1. Check Notion trash (30-day retention)
2. If not in trash: run `/manifest/heal` to recreate structure
3. Re-sync data from source systems (Trello, Stripe, GHL)
4. Verify with `/manifest/compliance`

---

### Level 2 — Automation Loop Failure

**Scenario:** Webhook loop, runaway sync, or infinite retry causing API exhaustion.

**Mitigation:**
- Global cooldown circuit breaker (trips after N failures)
- Runaway detection in job runner
- Stop reason logged to `job_runs`
- Manual override via `/admin/cooldown/reset`

**OpenClaw Response:**
1. Circuit breaker trips → all external writes paused
2. System enters `SAFE_MODE`
3. Auto-disables auto-move features
4. Logs cooldown activation to system_snapshots

**Recovery Steps:**
1. Check `/admin/system/health` for cooldown status
2. Review `job_runs` for stop reasons
3. Fix root cause (bad webhook, schema change, etc.)
4. Reset cooldown via admin endpoint
5. Re-enable features one at a time

---

### Level 3 — Data Corruption

**Scenario:** Relational integrity broken, orphaned records, hash mismatches.

**OpenClaw Response:**
1. Pause all webhooks (set `KILL_SWITCH=true`)
2. Snapshot current DB state to `system_snapshots`
3. Run full reconciliation across all systems
4. Validate all required IDs and relations

**Recovery Steps:**
1. Set `KILL_SWITCH=true`
2. Run `/sync/overview` to assess damage
3. Check `/sync/conflicts` for unresolved drift
4. Run reconcile jobs manually with `DRY_RUN=true` first
5. Review output, then run with `DRY_RUN=false`
6. Verify all entity mappings are intact
7. Set `KILL_SWITCH=false`

---

### Level 4 — Workspace Compromise

**Scenario:** Unauthorized access, credential leak, or account compromise.

**Immediate Actions:**
1. Set `KILL_SWITCH=true` (blocks all external writes)
2. Rotate Notion integration token
3. Rotate Trello API key + token
4. Rotate Stripe webhook secret
5. Rotate GHL API key
6. Rotate ClickFunnels webhook secret
7. Rotate admin ops token
8. Disable all webhook endpoints temporarily
9. Force password reset on all Notion workspace members

**Recovery Steps:**
1. Audit `audit_log` for unauthorized actions
2. Review `system_snapshots` for unexpected changes
3. Verify Notion workspace integrity via compliance check
4. Re-register all webhooks with new secrets
5. Re-enable system services one at a time
6. Monitor health endpoint for 24 hours

**Documentation:** `docs/runbooks/automation_down.md`

---

## Backup Schedule

| System | Method | Frequency | Retention |
|--------|--------|-----------|-----------|
| Notion | Workspace export | Weekly | 4 weeks |
| Trello | API board dump | Daily | 7 days |
| SQLite | File copy | Hourly | 24 hours |
| Stripe | Event log | Automatic | 30 days |
| QuickBooks | Cloud backup | Automatic | Perpetual |
| GHL | Contact export | Weekly | 4 weeks |

---

## Event Replay Buffer

OpenClaw stores all webhook events for 24 hours in `event_replay_buffer`.

If a sync failure occurs:
1. Identify failed events via `/replay/stats`
2. Get replayable events filtered by source
3. Replay events through normal processing pipeline
4. Mark events as replayed after successful processing
5. Purge events older than 24 hours

---

## Recovery Priority Order

1. **Stop the bleeding:** KILL_SWITCH, pause webhooks
2. **Assess damage:** health endpoint, conflict log, sync overview
3. **Snapshot state:** system_snapshots before any changes
4. **Fix root cause:** don't just re-sync blindly
5. **Dry-run recovery:** always DRY_RUN=true first
6. **Verify integrity:** compliance check, reconcile
7. **Resume operations:** re-enable features incrementally
