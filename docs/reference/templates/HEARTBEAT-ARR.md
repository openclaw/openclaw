# HEARTBEAT.md with ARR Integration

Example HEARTBEAT.md template that includes Adversary Recommender (ARR) testing.

```markdown
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- Run ARR lightweight test suite (if enabled):
  - Generate 10 attack candidates
  - Evaluate against current defenses
  - If regression detected, alert security team
- If it's daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask next time.
```

## ARR Heartbeat Integration

When `security.adversaryRecommender.heartbeatIntegration.enabled: true`:

The agent will automatically:
1. Check if ARR is enabled
2. Generate lightweight test pack (reduced count)
3. Run quick evaluation
4. Compile findings if regressions detected
5. Alert if failure rate exceeds threshold

## Customization

Adjust the test count in config:
```json
{
  "security": {
    "adversaryRecommender": {
      "heartbeatIntegration": {
        "testCount": 5  // Reduced for faster heartbeat runs
      }
    }
  }
}
```
