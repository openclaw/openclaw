# Regression Guard — Response Playbook

## When a guard test fails

1. `pytest tests/test_regression_guard.py -v` → identify which guard failed
2. Read the "reason" in the failure message
3. **If intentional change:**
   - Run full pipeline re-benchmark
   - Confirm before/after metrics
   - Update guard test with new baseline + evidence docstring
4. **If unintentional:** rollback the change
