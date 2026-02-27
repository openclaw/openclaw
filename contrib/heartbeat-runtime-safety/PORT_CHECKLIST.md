# PORT_CHECKLIST.md

## Goal
Prepare clean phase-1 port into OpenClaw repository branch.

## Branch Prep
- [ ] Locate OpenClaw git repo root.
- [ ] Create branch: `feat/heartbeat-runtime-safety-phase1`.

## Files to Port (Phase-1)
- `upstream/heartbeat-runtime-safety/preflight.sh`
- `upstream/heartbeat-runtime-safety/guard.sh`
- `upstream/heartbeat-runtime-safety/freshness.sh`
- `upstream/heartbeat-runtime-safety/test.sh`
- `upstream/heartbeat-runtime-safety/README.md`

## Docs to Add
- `docs/automation/heartbeat-runtime-safety.md` (new)

## Validation
- [ ] Run component tests
- [ ] Run smoke commands
- [ ] Verify no workspace-specific assumptions remain

## PR Assembly
- [ ] Use `PR_PATCH_OUTLINE.md`
- [ ] Use `PR_SUBMISSION_SEQUENCE.md`
- [ ] Finalize body from `PR_DRAFT_NOTES.md`
