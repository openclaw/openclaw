# TaskFlow Option C Migration

This note freezes the TaskFlow owner model targeted by the Option C migration before ACP runtime changes land.

## Current Owner Model

- Parent bound ACP work is discovered from child session metadata such as `spawnedBy` and `parentSessionKey`.
- `src/agents/acp-spawn.ts` and `src/acp/control-plane/manager.core.ts` currently create ACP task records directly and let the task layer mirror them into one task flows.
- Completion delivery depends on `requesterOrigin` plus bound conversation routing, but ownership is not yet anchored to a managed TaskFlow controlled by the real requester session.

## Target Owner Model

- Each autonomous ACP workflow should have one managed TaskFlow bound to the real requester session.
- The managed flow should keep the canonical `ownerKey`, `requesterOrigin`, and controller metadata for the workflow.
- ACP child runs should be created with `runTask` inside that managed flow instead of as detached background tasks.
- Flow state should track the active child, route snapshot, and workflow intent without duplicating transcripts or unbounded logs.

## Cutover Phases

1. Add this baseline note and red tests for the managed flow owner model.
2. Add an ACP TaskFlow orchestration helper that creates the managed flow and linked child task.
3. Wire ACP spawn and manager lifecycle updates to the orchestration helper.
4. Keep checkpoint and cron fallback behavior as a mirror until managed flow ownership and delivery are verified end to end.

## Rollback

1. Revert the ACP TaskFlow orchestration helper and its spawn and manager integrations.
2. Restore the workspace continuation fallback snapshot from the canonical backup anchor.
3. Verify detached ACP task creation and direct completion delivery still behave as they did before the migration.

## Invariants

- The managed flow `ownerKey` must equal the real requester session key.
- The managed flow `controllerId` must be explicit and stable for ACP owner workflows.
- The managed flow `requesterOrigin` must remain the canonical outward delivery route for linked ACP child tasks.
- Linked ACP child tasks must use the same `ownerKey` as the managed flow and set `parentFlowId` to that flow.
- Bound conversation routing must still win when available, especially for Discord threads and similar thread scoped channels.
- Duplicate `runId` suppression must not cross requester scopes or replace the wrong managed flow owner route.
