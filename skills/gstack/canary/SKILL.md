---
name: canary
description: |
  Post-deploy monitoring loop. Watches for console errors, performance
  regressions, and page failures. Periodic screenshots and anomaly detection.
  Use after deploying to production.
---

# Canary — Post-Deploy Monitoring

Extended monitoring after deployment. Watch for problems that only appear under real traffic.

**Related skills:** [land-and-deploy](../land-and-deploy/SKILL.md) | [qa](../qa/SKILL.md) | [benchmark](../benchmark/SKILL.md)

---

## Monitoring Loop

Run every 2-5 minutes for the specified duration (default: 30 minutes):

### Each Iteration

1. **Navigate** to the production URL
2. **Console errors** — any new JS exceptions since last check?
3. **Network errors** — any failed requests?
4. **Performance** — page load time within normal range?
5. **Screenshot** — visual comparison with previous iteration
6. **Key interactions** — test 2-3 critical flows (login, main feature, etc.)

### Anomaly Detection

Flag if any of these change between iterations:

- New console errors appear
- Network requests start failing
- Page load time increases > 50% from baseline
- Visual layout changes unexpectedly
- Key text content disappears
- HTTP status codes change (200 → 500)

---

## Output

```
CANARY REPORT
═══════════════════════════════════════
Duration:         30 minutes
Checks:           12
Anomalies:        0
Console errors:   0 new
Network errors:   0 new
Performance:      Stable (avg 1.8s LCP)
Status:           HEALTHY
═══════════════════════════════════════
```

If anomalies detected:

```
⚠️ ANOMALY DETECTED at [timestamp]
Type:     [console error / network failure / perf regression / visual change]
Details:  [specific error or change]
Action:   [recommend: investigate / revert / monitor]
```
