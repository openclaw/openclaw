# PORT_COMMANDS.md

## Suggested Commands (when in OpenClaw repo)

```bash
# 1) create feature branch
git checkout -b feat/heartbeat-runtime-safety-phase1

# 2) copy staged extraction files from workspace
cp /Users/openclaw/.openclaw/workspace/upstream/heartbeat-runtime-safety/preflight.sh tools/heartbeat/preflight.sh
cp /Users/openclaw/.openclaw/workspace/upstream/heartbeat-runtime-safety/guard.sh tools/heartbeat/guard.sh
cp /Users/openclaw/.openclaw/workspace/upstream/heartbeat-runtime-safety/freshness.sh tools/heartbeat/freshness.sh
cp /Users/openclaw/.openclaw/workspace/upstream/heartbeat-runtime-safety/test.sh tools/heartbeat/test.sh

# 3) add docs
cp /Users/openclaw/.openclaw/workspace/upstream/heartbeat-runtime-safety/README.md docs/automation/heartbeat-runtime-safety.md

# 4) run tests/smoke per repo conventions
# (placeholder: replace with OpenClaw repo's standard test commands)

# 5) commit
git add tools/heartbeat docs/automation/heartbeat-runtime-safety.md
git commit -m "feat(heartbeat): add runtime preflight/guard/freshness safety layer"
```

## Notes
- Adjust destination paths if OpenClaw repo structure differs.
- Keep commit scope phase-1 minimal.
