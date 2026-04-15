---
title: "Runbooks"
summary: "Step-by-step response guides for common production incidents and alert conditions"
read_when:
  - Responding to a production incident or alert
  - Gateway or channel is down and you need recovery steps
  - On-call and need a quick decision tree
---

# Runbooks

Quick-reference guides for the most common production issues.
For severity classification, see [SLOs and Ownership](./slo-and-ownership.md).
For structured postmortems, use the [Postmortem Template](./postmortem-template.md).

---

## RB-01: Gateway is unreachable

**Trigger:** `openclaw health` returns non-zero or times out.
**Severity:** S1 if all channels down; S2 if partial.

### Steps

1. Check if the gateway process is running:

   ```bash
   # macOS
   launchctl print gui/$UID | grep openclaw
   # Linux
   systemctl --user status openclaw-gateway
   # Docker
   docker compose ps
   ```

2. If the process is not running, restart it:

   ```bash
   # macOS (menubar app preferred; or scripts/restart-mac.sh)
   bash scripts/restart-mac.sh
   # Linux
   systemctl --user restart openclaw-gateway
   # Docker
   docker compose up -d
   # Manual (any platform) — graceful shutdown first, force-kill if needed
   pkill -15 -f openclaw-gateway || true
   sleep 5
   pkill -9 -f openclaw-gateway 2>/dev/null || true
   nohup openclaw gateway run --bind loopback --port 18789 --force \
     > /tmp/openclaw-gateway.log 2>&1 &
   ```

3. Verify startup:

   ```bash
   openclaw health --verbose
   ss -ltnp | grep 18789
   tail -n 120 /tmp/openclaw-gateway.log
   ```

4. If still unhealthy, check logs for startup errors:

   ```bash
   # macOS
   ./scripts/clawlog.sh --follow
   # All
   tail -200 /tmp/openclaw/openclaw-*.log | grep -E "error|fatal"
   ```

5. Run doctor to fix common config regressions:

   ```bash
   openclaw doctor --repair
   ```

6. If unresolved after 15 min, escalate to S1 and open an incident.

---

## RB-02: Channel disconnected

**Trigger:** `openclaw status --all` shows a channel as disconnected or stale.
**Severity:** S2 for primary channel; S3 for secondary.

### Steps

1. Identify the disconnected channel:

   ```bash
   openclaw status --all
   openclaw health --verbose
   ```

2. Attempt a soft reconnect (channel-specific):

   ```bash
   # WhatsApp
   openclaw channels login --channel whatsapp --verbose
   # Telegram / Discord / Slack / Signal / etc.
   openclaw channels login --channel <name> --verbose
   ```

3. If soft reconnect fails, log out and re-link:

   ```bash
   openclaw channels logout --channel <name>
   openclaw channels login --channel <name>
   ```

4. For status codes 409–515 (WhatsApp): the QR/pairing flow auto-retries once for 515.
   If it loops, clear credentials and re-link:

   ```bash
   rm -rf ~/.openclaw/credentials/whatsapp/<accountId>
   openclaw channels login --channel whatsapp
   ```

5. Verify health and inbound messages:

   ```bash
   openclaw health --verbose
   openclaw status --deep
   ```

6. Check channel provider status pages for outages before assuming a local issue.

---

## RB-03: Agent not responding

**Trigger:** Messages arrive but no agent reply; no activity in `openclaw sessions list`.
**Severity:** S2.

### Steps

1. Verify the agent is reachable:

   ```bash
   openclaw agent --message "ping" --thinking low
   ```

2. Check model provider health:

   ```bash
   openclaw models list --probe
   ```

3. Check for context overflow or compaction issues in logs:

   ```bash
   grep -E "compaction|overflow|context" /tmp/openclaw/openclaw-*.log | tail -50
   ```

4. Check for quota errors (look for `429` or `billing` in logs):

   ```bash
   grep -i "429\|quota\|billing\|rate limit" /tmp/openclaw/openclaw-*.log | tail -20
   ```

5. Verify API key is valid:

   ```bash
   openclaw status --all   # look for auth age warnings
   ```

6. Restart the gateway to clear any stuck agent state:

   ```bash
   openclaw gateway restart   # or platform-specific restart (see RB-01)
   ```

---

## RB-04: Auth secret rotated / sessions lost

**Trigger:** Gateway bearer secret was rotated; existing client sessions rejected.
**Severity:** S3.

### Steps

1. Check recent auth rotation in logs:

   ```bash
   grep "auth rotated\|secret rotated" /tmp/openclaw/openclaw-*.log | tail -20
   ```

2. Re-pair any disconnected nodes or apps:

   ```bash
   openclaw pairing list
   # Re-pair via the app or QR code flow
   ```

3. For programmatic clients using the old bearer, update the token in config or `.env`:

   ```bash
   openclaw config set gateway.auth.token <new-token>
   ```

4. Verify health after re-pairing:

   ```bash
   openclaw health --verbose
   ```

---

## RB-05: Release rollback

**Trigger:** A published npm release causes widespread regression.
**Severity:** S1 (if critical) or S2.

### Steps

1. Identify the last known-good version:

   ```bash
   npm view openclaw versions --json | tail -5
   ```

2. Roll back (release managers only):

   - Log into the private maintainer release docs runbook.
   - Re-point the `latest` dist-tag: `npm dist-tag add openclaw@<prev-version> latest`
   - For macOS app: re-publish previous Sparkle appcast entry (see maintainer docs).

3. Notify users in Discord `#releases` and GitHub Discussions.

4. Open a postmortem (see [Postmortem Template](./postmortem-template.md)).

5. Fix the root cause, cut a corrective release (`YYYY.M.D-N`), and validate before
   re-promoting `latest`.

---

## RB-06: High error rate in logs

**Trigger:** > 5 errors/min from `grep -c "error" /tmp/openclaw/openclaw-*.log`.
**Severity:** S2 (sustained) or S3 (transient).

### Steps

1. Sample the error messages to classify:

   ```bash
   grep "error" /tmp/openclaw/openclaw-*.log | tail -50 | sort | uniq -c | sort -rn
   ```

2. Check if errors are from a single channel (channel failure) or spread (gateway/model):

   - Channel-local: follow RB-02
   - Model-related: follow RB-03
   - Auth-related: follow RB-04

3. If errors include stack traces, capture the full trace for the postmortem:

   ```bash
   grep -A 20 "Error:" /tmp/openclaw/openclaw-*.log | head -100
   ```

4. If root cause is unclear after 30 min, escalate and open an incident.

---

## RB-07: Dependency vulnerability alert

**Trigger:** Dependabot or CodeQL alert; `npm audit` shows a high/critical vuln.
**Severity:** S2 (high/critical with reachable exploit) or S3 (non-reachable).

### Steps

1. Triage the alert using the [Vulnerability SLA](./vulnerability-sla.md) criteria.
2. If critical and reachable: apply the Dependabot patch PR immediately, run
   `pnpm build && pnpm check && pnpm test`, and cut a corrective release.
3. If high but not immediately reachable: merge in the next regular release cycle.
4. If false positive: document the rationale and close with `wont_fix` label.
5. For GHSA advisories, use the `$openclaw-ghsa-maintainer` skill.

---

## Quick reference card

| Symptom | Runbook |
|---|---|
| Gateway unreachable | RB-01 |
| Channel disconnected | RB-02 |
| Agent not responding | RB-03 |
| Sessions lost after auth change | RB-04 |
| Bad release, need rollback | RB-05 |
| High error rate in logs | RB-06 |
| Dependency vulnerability alert | RB-07 |
