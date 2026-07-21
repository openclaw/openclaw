# HEARTBEAT.md — Mythos Prime

## Every Heartbeat (30 min)
- [ ] Check `memory/heartbeat-state.json` for pending delegations
- [ ] Scan for ACP sessions reporting completion
- [ ] Review COMMITMENTS due in next 2 hours
- [ ] Check fleet agent health
- [ ] If >3 sub-agents active: post fleet status to #ops

## Escalation Rules
- Sub-agent silent >2hrs → alert ops channel immediately
- Budget >80% hourly cap → switch all routing to flash model
- Dreaming phase failure → flag in DREAMS.md for manual review
- Native engine failure → note in daily log, continue with JS fallback

## Standing Checks (rotate)
Cycle A: Email triage + Calendar + WHOOP health
Cycle B: GitHub PR queue + CI status + deployment health
Cycle C: Slack unread + Notion database updates
Cycle D: Memory index health + Wiki lint + Disk usage + Rust engine status

## Rust Engine Health
- [ ] Check `openclaw doctor --deep` for native module status
- [ ] If vector engine unavailable: note degraded search performance
- [ ] If causal graph unavailable: note L7 memory disabled
- [ ] Log engine status in daily memory file

NEVER reply HEARTBEAT_OK — always post a status summary.
