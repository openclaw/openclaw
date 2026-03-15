# Add config restore command with auto-restart

## Summary

- **Problem**: When `openclaw.json` becomes corrupted, Gateway fails to start and `openclaw doctor --fix` cannot handle this scenario
- **Why it matters**: Users lose access to the system when config file is corrupted, with no easy recovery path
- **What changed**: Added `openclaw config restore` command that restores config from `.bak` backup and auto-restarts Gateway
- **What did NOT change**: Existing backup mechanism (`maintainConfigBackups`) remains unchanged; only added recovery path

## Change Type

- [ ] Bug fix
- [x] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [x] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Related to backup mechanism in `src/config/backup-rotation.ts`

## User-visible / Behavior Changes

**New command**: `openclaw config restore`

- Restores `openclaw.json` from `openclaw.json.bak`
- Validates restored config before applying
- Automatically restarts Gateway if restore succeeds
- No command-line arguments required

## Security Impact

- New permissions/capabilities? `No`
- Secrets/tokens handling changed? `No`
- New/changed network calls? `No`
- Command/tool execution surface changed? `Yes`
- Data access scope changed? `No`
- **Explanation**: New CLI command added that reads/writes config files (same permissions as existing `config set/unset` commands). Uses existing `emitGatewayRestart()` for restart.

## Repro + Verification

### Environment

- OS: Windows 11 / macOS / Linux
- Runtime: Node.js 22+
- Config: Standard openclaw.json with backup file present

### Steps

1. Corrupt `openclaw.json` (e.g., add invalid JSON syntax)
2. Verify Gateway fails to start
3. Run `openclaw config restore`
4. Verify config is restored and Gateway restarts

### Expected

- Backup file copied to main config
- Config validated successfully
- Gateway restarts automatically
- Success message displayed

### Actual

- ✅ All expected behaviors confirmed

## Evidence

- [x] Code changes in `src/cli/config-cli.ts`
- [x] Test coverage added in `src/cli/config-cli.test.ts`
- [x] Uses existing `maintainConfigBackups` mechanism
- [x] Integrates with `emitGatewayRestart()` for auto-restart

## Human Verification

**Verified scenarios**:

- Restore from valid backup file
- Error handling when backup file missing
- Config validation after restore
- Auto-restart trigger

**Edge cases checked**:

- Backup file exists but contains invalid config
- No backup file present
- Backup file permissions

**What I did NOT verify**:

- Cross-platform restart behavior (macOS LaunchAgent vs systemd)
- Backup rotation edge cases (already covered by existing tests)

## Review Conversations

- [x] I replied to or resolved every bot review conversation I addressed in this PR.
- [x] I left unresolved only the conversations that still need reviewer or maintainer judgment.

## Compatibility / Migration

- Backward compatible? `Yes`
- Config/env changes? `No`
- Migration needed? `No`

No breaking changes. New command is additive only.

## Failure Recovery

**How to disable/revert**:

- Revert commit or merge main branch
- Command is isolated; no config changes required

**Files to restore**:

- `src/cli/config-cli.ts`
- `src/cli/config-cli.test.ts`

**Known bad symptoms**:

- If restore fails, user can manually copy `.bak` file
- If auto-restart fails, manual restart still works

## Risks and Mitigations

- **Risk**: Restoring from an old backup might lose recent config changes
  - **Mitigation**: Backup is created on every config write, so `.bak` is always the last known good state

- **Risk**: Auto-restart might fail on some platforms
  - **Mitigation**: Command shows appropriate message if restart fails, prompting manual restart
