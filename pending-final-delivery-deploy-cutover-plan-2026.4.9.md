# pendingFinalDelivery Deploy / Cutover Plan for 2026.4.9

## Target

Current local OpenClaw runtime confirmed by `openclaw status`:

- version: `2026.4.9`
- git: `253ecd2a`
- gateway service: running

## Deploy artifact

- `pending-final-delivery-v2026.4.9-full.patch`

Patch scope:

- `src/agents/subagent-registry.types.ts`
- `src/agents/subagent-registry-lifecycle.ts`
- `src/agents/subagent-registry.test.ts`
- `src/agents/subagent-registry-lifecycle.test.ts`
- `src/agents/subagent-registry.persistence.test.ts`

## What this ships

- durable `pendingFinalDelivery` payload on the run record
- restart/resume cleanup that prefers durable payload over mutable live fields
- fix for payload overwrite on failed retry
- targeted persistence/retry coverage

## Validation already done

Ran and passed:

- `pnpm --dir /home/mertb/.openclaw/workspace/openclaw-src exec vitest run src/agents/subagent-registry.persistence.test.ts src/agents/subagent-registry.test.ts src/agents/subagent-registry-lifecycle.test.ts --reporter=dot`
- result: **29 tests, 0 fail**

## Suggested cutover flow

1. Confirm there are no critical active tasks.
2. Snapshot the current install / checkout.
3. Apply `pending-final-delivery-v2026.4.9-full.patch` to the exact `2026.4.9` source tree.
4. Re-run the targeted tests above on the target tree.
5. Build/package explicitly:
   - `pnpm --dir <repo> build`
   - `pnpm --dir <repo> ui:build`
   - `cd <repo> && OPENCLAW_PREPACK_PREPARED=1 npm pack --json --pack-destination <pack-dir>`
6. Verify tarball contents:
   - `package/dist/index.js`
   - `package/dist/control-ui/index.html`
7. Install tarball globally:
   - `npm install -g --force <tarball>`
8. Restart gateway:
   - `openclaw gateway restart`
9. Verify:
   - `openclaw status`
   - subagent completion flow retries still work
   - no duplicate final delivery
   - `pendingFinalDelivery*` clears after success

## Fast rollback

1. Keep the pre-cutover tarball or currently installed version info before global reinstall.
2. Reinstall the previous tarball/package.
3. Restart gateway.
4. Re-run `openclaw status`.
5. If needed, restore saved subagent state snapshot.

## Risk notes

- This is a small, targeted lifecycle fix, but it touches reply/cleanup behavior.
- Highest-value verification is one real deferred/failing completion flow after restart.
- Do not mix this patch with an unrelated OpenClaw version bump during the same cutover.

## Recommended next operational move

The exact operator sequence is now encoded in:

- `pending-final-delivery-2026.4.9-apply-commands.sh`

Best next move:

- run it first as dry-run on the source tree
- then rerun with `INSTALL_GLOBAL=1 RESTART_GATEWAY=1` only when the tarball and tests look clean
