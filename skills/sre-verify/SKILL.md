---
name: sre-verify
description: "Use after incident remediation, post-deploy, or post-PR-merge to verify fixes are effective. Re-runs evidence collection from the incident, smoke-tests affected services, confirms deployed images include fix commits, and compares current metrics against pre-incident baselines."
metadata: { "openclaw": { "emoji": "✅" } }
---

# sre-verify

Companion skill to `morpho-sre`. Use this skill after incident remediation,
post-deploy, or post-PR-merge to confirm that the fix is effective and no
regressions have been introduced.

Reply with conclusions only in ALL communications — Slack, DMs, PR comments, Linear comments, every output surface. No investigation steps, intermediate reasoning, or tool output summaries. All investigation work happens silently; only the final summary is sent.

---

## Post-fix validation

Re-run the exact failing evidence path from the incident to confirm the fix.

1. **Replay evidence commands** - Execute the same `kubectl`, database, API, or
   log queries that originally surfaced the bug during the incident.
2. **Compare output** - Diff current output against the incident's evidence
   section. Look for:
   - The specific error/pattern that was present before the fix
   - Expected healthy output matching the service's normal baseline
3. **Verdict**:
   - **confirmed-fixed** - The original failure signal is absent and healthy
     output is observed.
   - **still-failing** - The same failure signal persists.
   - **regressed-differently** - The original signal is gone but a new,
     different failure has appeared.

### Evidence replay examples

```bash
# Re-run the exact kubectl command from the incident
kubectl logs deploy/<service> -n <namespace> --since=10m | grep -i "error\|panic\|fatal"

# Re-run the DB query that showed stale data
db-evidence.sh --mode data --namespace <namespace> --target <service>

# Re-run the API call that was failing
curl -sf https://<endpoint>/health | jq .
```

---

## Post-deploy validation

Verify the deployment contains the fix and the service is stable.

1. **Confirm fix commit is deployed**:

   ```bash
   kubectl get deploy/<name> -n <namespace> \
     -o jsonpath='{.spec.template.spec.containers[*].image}'
   ```

   Then correlate the image tag to the fix commit SHA. Verify the commit is an
   ancestor of the deployed tag.

2. **Smoke-test affected endpoints**:
   - Run health checks on the affected service
   - Execute key API calls that exercise the fixed code path
   - Verify response codes, response times, and payload correctness

3. **Check pod stability** (5-minute window post-deploy):

   ```bash
   kubectl get pods -n <namespace> -l app=<service> \
     -o custom-columns='NAME:.metadata.name,RESTARTS:.status.containerStatuses[0].restartCount,STATUS:.status.phase,REASON:.status.containerStatuses[0].state.waiting.reason'
   ```

   - No restarts since deploy
   - No OOMKilled or CrashLoopBackOff
   - All pods in Running state with ready condition

---

## Post-PR validation

Confirm the full CI/CD pipeline completed successfully after merge.

1. **CI passed on merged PR**:

   ```bash
   gh pr view <pr-number> --json mergeCommit,statusCheckRollup \
     --jq '.statusCheckRollup[] | "\(.context): \(.state)"'
   ```

2. **ArgoCD sync shows new image**:

   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/argocd-sync-status.sh
   ```

   The script emits a scoped TSV report. Verify sync status is "Synced" and
   the deployed image matches the merged PR's build artifact.

3. **No new alerts in 15 minutes post-deploy**:
   - Check BetterStack for new incidents in the affected service
   - Check Prometheus for alerting rules that fired after deploy timestamp
   - Check Sentry for new issues tagged with the deployed release

---

## Regression detection

Compare current state against pre-incident baseline to catch regressions.

1. **Prometheus metrics comparison**:

   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/prometheus-trends.sh
   ```

   Review the output for error rate, latency, and throughput changes.

   Key metrics to compare:
   - Error rate (5xx, panics, exceptions)
   - Latency (p50, p95, p99)
   - Throughput (requests/sec)
   - Resource usage (CPU, memory, connections)

2. **Sentry issue check**:

   ```bash
   sentry-cli.sh issues --project <project> --since <deploy-timestamp>
   ```

   Look for new issues or re-opened issues in the affected service.

3. **Specific pattern verification**:
   Verify the exact metric, log pattern, or error message from the incident is
   no longer present. This is the strongest signal that the fix works.

---

## Verification checklist template

Copy and fill in after completing verification:

```
*Verification:* [incident-id or PR URL]
*Fix deployed:* yes/no (image: <tag>, commit: <sha>)
*Evidence re-run:* pass/fail
*Service health:* stable/degraded
*New alerts:* none / [list]
*Verdict:* ✅ confirmed-fixed / ❌ still-failing / ⚠️ partially-fixed
```

### Verdict definitions

| Verdict            | Meaning                                      | Next action                             |
| ------------------ | -------------------------------------------- | --------------------------------------- |
| ✅ confirmed-fixed | Original issue resolved, no regressions      | Close incident, update postmortem       |
| ❌ still-failing   | Original issue persists after deploy         | Re-open investigation, escalate         |
| ⚠️ partially-fixed | Original issue resolved but new issues found | Open follow-up incident for regressions |

---

## When to use this skill

- **After merging a fix PR** - Run post-PR and post-deploy validation
- **After deploying a hotfix** - Run full post-deploy and regression detection
- **During incident follow-up** - Re-verify a previously "fixed" incident
- **Scheduled re-verification** - Periodic check that past fixes remain effective
- **After infrastructure changes** - Verify services remain healthy after
  cluster upgrades, config changes, or dependency updates
