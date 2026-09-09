---
summary: "Dispatch, workspace reconciliation, moves, stop and reclaim, recovery, and what survives a dead machine"
title: "Cloud session lifecycle and durability"
read_when: "You are moving, stopping, or recovering a placed session, or you need to know what survives a lost machine."
---

What `sessions.dispatch` does, how completed turns are reconciled back to the Gateway, how moves, stops, and reclaims behave, and which state outlives the machine.

`sessions.dispatch` closes local turn admission, drains active work, validates the workspace source, provisions the lease for the selected execution mode, and runs setup. With project warm images enabled, it prepares the committed checkout and node runtime and captures any needed image before enrollment. It then enrolls the node, installs the required pinned Gateway bundle, applies the session workspace, and returns once the placement reaches `active` ownership. Gateway-source inventory validation happens before provider allocation. Repository-only inventory is captured on the enrolled node after fetching the pinned source; either path reports actionable size or entry limits. Budget several minutes for the first cloud dispatch, including capture when needed; later dispatches can reuse the image, project seed, and runtime installs. After that, talk to the session as usual. OpenClaw turns route to the worker process; Codex native operations run on the authorized cloud node, paired device, or supported SSH-backed provider.

Workspace manifest downloads use gzip when the node supports it and remain compatible with uncompressed transfers. Both the compressed response and its decoded manifest stay within the 64 MiB safety limit; the node verifies the decoded manifest before changing the workspace.

For a Gateway-source worktree, synchronization is not continuous: OpenClaw sends a fresh eligible inventory at dispatch, not before every turn on an existing worker. Files created only on the Gateway after dispatch remain local and outside the accepted manifest. To send those new inputs, finish the current turn, stop the cloud worker, and dispatch again.

Remote-exec skill bundles are private, read-only turn inputs inside the execution workspace. Transfer groups their files into bounded batches to avoid a separate network round trip for every small file. They are ignored by ordinary Git staging and excluded from workspace synchronization and reconciliation. Normal turn cleanup removes them; cleanup failures are reported. Before preparing the next turn, OpenClaw removes leftover private skill copies from that workspace, including copies whose initialization response was lost. This also runs when the new turn selects no skills. Recovery preserves attachments and unrelated directories, and a cleanup failure stops preparation with retry guidance.

The skill catalog and explicit skill references point to the current turn's worker copy. Instructions and relative scripts use that same location; edits to the Gateway source apply to later turns.

Disconnected workers have no cleanup deadline. Nodes also reclaim copies when the authoritative retention snapshot releases their workspace generation, including after restart; SSH-backed copies follow workspace/provider teardown. Restarting a node alone does not delete a retained generation. Skill-copy paths last only for their turn, so background commands must not depend on them remaining available afterward.

Completed cloud turns preserve eligible, size-bounded workspace files before the turn claim is released. Repository-only sessions accept a cumulative immutable checkpoint in the Gateway's bare artifact repository. Gateway-source sessions apply those changes to their managed worktree. Worker-turn uses its terminal worker event to create the durable pending-result fence. Remote-exec waits for workspace quiescence and enters the same reconciliation flow after the local Codex attempt. Before applying the result, the Gateway stages complete authenticated base/current manifests plus each changed resulting blob as a Git ref under `refs/openclaw/worker-results/`; deletions are represented by the manifests and need no blob. This keeps the cloud delta recoverable even if the Gateway stops during the apply without duplicating unchanged baseline content. Workspace results use Git file semantics: regular files, executable bits, symlinks, additions, changes, and deletions are retained, while empty directories and other directory modes are not. Gateway-source changes remain in the managed worktree for normal review and commit; repository-only changes remain on the node and in the accepted checkpoint.

If workspace transfer ownership closes during an upload, the Gateway disconnects the uploader promptly, including while it waits for validation after sending all bytes. The cancelled upload cannot become an accepted workspace result.

Replacement and Gateway Move restore files against the pinned base; they do not restore worker commit history, merge stages, or partial staging. After a recorded cloud publication, Gateway Move continues the local branch from that verified pushed commit while keeping later accepted file changes available for review. Review recovered conflict-marker files before continuing. When a publishable checkpoint is available, restoration marks its added files as intent-to-add, keeping added and edited contents unstaged for review. Accepted publication deletions are restored as staged index removals; any recovered file bytes remain available. Ignored recovery-only files and attachments are not enrolled for publication. If publication capture was unavailable, recovered ignored files need an explicit `git add -f` before publishing.

For each OpenClaw `worker-turn`, the Gateway binds its effective shared GitHub identity into the worker's `exec` launches, using the same [`tools.github`](/gateway/config-tools#tools-github) selection as ordinary Gateway-host exec. When that identity is available, `gh` is authenticated and HTTPS `git push` uses the `gh auth git-credential` helper. The worker checkout carries the session-owned branch name and, for GitHub repositories, an HTTPS `origin`. The agent commits and pushes directly from the worker. Reconciliation preserves file contents, not the worker's commit history, so work pushed from the worker lands on GitHub first. At every turn start, the worker fast-forwards its checkout to the session branch on `origin` when the local branch is behind, bringing in history pushed by an earlier worker; a diverged local branch is left untouched.

Codex `remote-exec` sessions and the Control UI **Publish PR** action use the Gateway publication broker; remote-exec agents request publication with `github_publish`. Repository-only publication uses an accepted Git-normalized checkpoint without creating a Gateway checkout. Shared or explicitly selected personal publication can use that checkpoint after Stop; personal credentials remain on the Gateway. See [Publish with your account](/concepts/user-model#publish-with-your-account).

For Gateway-source worktrees, apply uses the latest accepted manifest as the merge base, initialized at dispatch and advanced after each accepted reconciliation. Cloud-only changes are applied, local-only changes stay in place, and paths changed on both sides use a three-way keep-local policy. A conflicted turn still finishes: the transcript reports the bounded path summary and staged result ref, the placement exposes the same conflict for the Control UI, and non-conflicting cloud changes remain applied. The notice includes `git show <ref>:<path>` to inspect a present cloud file and a top-level literal-pathspec `git checkout <ref> -- <path>` command to take it from any workspace directory. Run the commands in Bash or zsh (Git Bash on Windows). If inspect says the path does not exist, the cloud result deleted it; verify and remove the retained local path manually. If checkout reports a file/directory obstruction, move or remove the blocking local path and retry. If the staged ref itself is gone, treat the notice as stale and do not change the local path. Conflicted staged refs remain available after the normal turn fence is released; a later clean result clears the notice and retires the old ref, while explicit fence removal is the final cleanup boundary.

While a fenced result is still reconciling, the Control UI accepts a follow-up into durable custody and shows that it is waiting for workspace synchronization. The Gateway starts the follow-up automatically after the prior claim releases; do not resend it. If reconciliation fails, the placement reports the recovery error and keeps the queued input available for the recovery flow. On restart, recovery discovers pending and staged results before stale-claim cleanup, completes checkpoint acceptance or local apply, and reclaims dead environments only after preserving the result. An accepted Stop result can finish cleanup after restart even when its cloud environment is already destroyed; this does not restore the old turn's live authority. For Gateway-source worktrees, the bounded SQLite rollback journal makes an interrupted filesystem apply recoverable without replaying already accepted mutations.

To continue the same session somewhere else, open the **Runs on Cloud** chip and choose **Move session…**. An operator with `operator.write` can select the Gateway or an eligible paired device; selecting a configured cloud profile requires `operator.admin`. Profiles may also offer operating systems and machine classes, with the machine list filtered to the selected system. Moving to the current profile with a different effective operating system or class replaces its worker; it is not an in-place resize, and native size overrides may take precedence over classes. The Gateway closes new admission, interrupts any active turn, reconciles the source workspace, destroys the old environment, and then activates the destination. An interrupted turn is never replayed: partial output may disappear, and you send the next turn again after the move. The exact target, including operating-system and machine overrides, and bounded errors are durable, so the Control UI shows **Moving to…** or the recovery error after a reconnect. If the Gateway restarts before the destination becomes active, request-bound authority is lost: recovery finishes safe source cleanup, marks the placement failed with a retry message, and does not provision the destination. Reconnect, then choose **Move session…** again.

An active paired-device placement stays `active` when its runner disconnects.
Control UI shows **Device offline** and **Waiting for device to reconnect; retry
after it returns**. Waiting is the default and keeps the remote owner and
workspace intact. Any in-flight Codex `remote-exec` attempt fails visibly, its
node exec-server and child processes are terminated, and reconnecting the same
paired device allows a fresh attempt only; the disconnected stdio session is
never resumed. **Continue on Gateway…** is explicitly destructive: after a
data-loss confirmation, it abandons the exact offline device owner and resumes
from the last Gateway-synced workspace without replay. Unsynced device files
and in-flight work may be lost. This explicit abandonment also fences an active
local Codex turn claim without waiting for an acknowledgment from the offline
node. The Gateway revokes the abandoned worker's credentials, tools, and result
authority before returning the session to local ownership. It retains the exact
old device cleanup scope until reconnection confirms physical worker shutdown;
this cleanup cannot stop or revoke a later session owner, including after a
Gateway restart. Continue on Gateway does not claim that the offline process has
already stopped. If the device is already available, use the
ordinary reconcile-first move instead.

To stop a running turn in the Control UI, use chat **Stop** or `/stop` first. Once no turn is running, choose **Stop cloud worker…** from the placement chip. The Gateway performs one final workspace reconciliation before it destroys the environment. A placement already in `draining` or `reconciling` is finishing teardown; wait for its badge to become `reclaimed` before resetting or deleting the session. An environment in `draining` or `destroying` has not yet confirmed release: teardown errors remain visible, and Stop can be retried. Starting another turn after reclaim provisions a replacement worker only while its original cloud profile remains configured for the same provider; deleting that profile prevents new cloud allocation.

Archiving or deleting a non-main cloud-worker session with an active placement first interrupts and drains its current work, then safely reclaims the worker. The Gateway records the archive or deletion only after final reconciliation and safe teardown succeed. If reclaim is unavailable, fails, or the placement is transitioning or failed without proof that its environment is gone, the operation reports an error and retains the session and recovery state; it never force-discards unsynced work. When a failed placement still needs cleanup, the archive error directs you to **Stop cloud worker…** rather than retrying archive automatically. Resolve any provider error from Stop, then retry archive after cleanup is confirmed. Restoring an archived session retains reclaimed placement metadata so the next turn can dispatch a fresh worker with the same workspace profile.

For a broken or runaway cloud environment, an administrator can call the admin-only `environments.destroy` method with `{ "force": true }` as a last resort. Forced teardown durably marks the placement failed and abandons any unreconciled remote result before destroying the environment. For an unreachable paired device, forced destroy succeeds without waiting for reconnection and discards unsynced device changes.

The equivalent write-scoped session RPC is:

```bash
openclaw gateway call sessions.reclaim \
  --timeout 600000 \
  --params '{"key":"agent:main:big-refactor"}'
```

Calling `sessions.reclaim` while a turn is active cancels running and pending work and records the active turn’s stopped outcome before workspace reconciliation and teardown. Inputs already waiting, or submitted while reclaim is in progress, do not restart the worker when reclaim completes. Send a new message after reclaim finishes to start new work.

`sessions.reclaim` also cancels a dispatch that is still preparing or provisioning, including project snapshot and transfer work before enrollment. The UI exposes **Stop cloud worker…** once a requested or provisioning placement appears. Crabbox stops the active acquisition/setup command, readiness wait, or enrollment wait, then the Gateway completes authoritative lease cleanup before reporting success. The initial prompt remains **Not sent**; only an explicit retry sends it later. A provider that cannot interrupt an operation still retains its cleanup ownership until that operation settles. Cancellation never reports a caller timeout as proof of release.

Cancellation does not wait for unrelated provider inspections. Final reconciliation and machine release still wait for earlier placement operations to finish. A later dispatch or move of the same session waits for reclaim, so it cannot replace the worker before Stop finishes.

The result placement is `reclaimed` after an active worker is safely stopped. Reclaim also waits for an in-flight dispatch and retries pending teardown for a failed placement before returning `local`. No other placement states are successful reclaim results.

Crabbox lease teardown reserves time for the CLI's full bounded release attempts, retries, cleanup observation, and process settlement. Inspection keeps its shorter timeout. Failed node enrollment also reserves time for diagnostics before teardown; optional image capture has its own additional budget.

If provider teardown fails or times out during stop or move, the request reports the bounded, redacted provider cause even if recovery subsequently finishes cleanup. Retrying Stop on a failed placement reports that cleanup attempt's cause, which can differ from the original session failure. Follow the reported recovery guidance and check the current placement before retrying. A dedicated cloud worker can remain recorded as attached while destruction is uncertain, but its closed authority cannot resume remote workspace processes.

While cleanup remains pending, the placement keeps the original failure and the latest cleanup cause. Repeated recovery checks do not append another copy of the same error, and long diagnostics retain the final provider cause.

An ended or unusable provider lease is not proof that its machine was deleted. OpenClaw fences that worker, stops renewing the lease, and requests explicit provider teardown. Failed teardown stays retryable; a missing local claim or an earlier “not found” warning does not turn a failed stop into success.

For automation, read the active placement's `generation`, `environmentId`, and `activeOwnerEpoch` from `sessions.describe`, then supply those exact source facts to `sessions.move`:

```bash
openclaw gateway call sessions.move \
  --timeout 1500000 \
  --params '{"key":"agent:main:big-refactor","expected":{"generation":5,"environmentId":"worker:source","ownerEpoch":2},"target":{"kind":"gateway"}}'
```

Worker targets use `{"kind":"profile","profileId":"aws","os":"linux","machineClass":"tiny"}` or `{"kind":"device","deviceId":"paired-device-id"}`. Omit `os` or `machineClass` to use the corresponding profile default. Moving to the same profile with a different operating system or class replaces the worker. A stale source is rejected rather than moving a newer placement. Successful results end in `local` for the Gateway target or `active` for a worker target.

An explicit move of a repository-only session to the Gateway fetches its pinned source into a managed project, creates a managed worktree, and restores its accepted checkpoint before enabling local turns. Ordinary creation, Stop, restart, and publication do not materialize this checkout. Moving requires upstream access to the pinned commit, any recorded publication commit, and enough Gateway disk space for the normal managed-worktree flow. The move requires in-flight publication to settle and rejects a remote branch that differs from the recorded push; it never adopts an unrelated remote tip. Fetching uses the shared repository identity, so a prior personal publication does not require reconnecting that personal account to move.

Automation may explicitly abandon an offline paired-device source by adding
`"abandonSource":true` to the exact-source Gateway request above. The field is
rejected for profile or device targets and when the source runner is available
or cannot be proven to be the exact device binding. This path has the same
unsynced-file and in-flight-work loss boundary as the Control UI confirmation.

Placement moves through a durable state machine (`local → requested → provisioning → syncing → starting → active`), so a Gateway restart mid-dispatch reconciles instead of leaking machines; interrupted pending provisioning retains its fixed provider operation for startup replay. A failed model turn keeps the active placement available for a retry. In Gateway-source worktrees, workspace path conflicts keep the local version, apply the rest of the cloud result, and preserve the staged cloud ref for inspection; other reconciliation or lifecycle failures retain their durable recovery fence and diagnostic tail until recovery can safely retry or reclaim the environment.

Recovery requested for one worker inspects that environment and resumes only its associated workspace results and moves. Regular background sweeps still reconcile all environments. Recovery continues to wait for earlier placement operations to finish.

If a turn reports `Cloud worker finished, but its workspace result could not be reconciled`, inspect the cause after the colon. A failed node manifest capture includes its bounded, redacted stderr, or its termination status when stderr is empty. Node cleanup preserves manifests needed between upload and verification, including when other workers finish simultaneously; increasing transfer timeouts does not repair a missing manifest.

## What survives a dead machine

The Gateway owns the canonical session transcript in both modes. Worker-turn commits each complete user, assistant, and tool-result message before the worker's session write settles; remote-exec uses the normal local harness transcript path because the Codex app-server stays on the Gateway. If the machine disappears mid-message, durable history ends at the last committed message. Partial text or tool progress already shown by the live stream may disappear; the failed turn remains visible, and the failed placement records a bounded terminal reason above the composer.

Worker-turn live previews are snapshots of the current assistant message. Corrections, shorter previews, and empty replacements update that message without replaying or erasing earlier messages in the turn. Explicit commentary is kept out of answer text, including when its phase arrives at message completion. Live previews are bounded and can be dropped after stream degradation; the committed transcript remains authoritative.

Workspace state has a wider loss window. A completed turn reconciles cloud files before releasing its claim, and **Stop cloud worker…**, archiving, or deleting a session performs final reconciliation before destroying an active worker. Changes made between reconciliations exist only on the box and can be lost if that box disappears. Deletion proceeds only after safe reclaim succeeds. For a Gateway-source session it snapshots the managed worktree under `refs/openclaw/snapshots/` before removing it; for a repository-only session it deletes the source owner and retained checkpoint artifacts. A failed safe reclaim retains the session and unsynced recovery state and reports an error.

For repository-only sessions, the Gateway retains complete base/current file manifests and changed file contents in immutable checkpoints. It does not keep a full copy of upstream Git history or unchanged base files. Replacement workers therefore need the pinned upstream commit to be fetchable or already present in the node's verified seed cache. An explicit Gateway move needs that commit available to its project clone. A moved or deleted remote branch does not change the pinned commit, but losing access to that commit can prevent restoration.

Checkpoint history stays until session deletion; the managed-worktree seven-day idle cleanup and thirty-day snapshot expiry do not apply. Back up the [state database and repository artifacts](/reference/database-schemas#cloud-repository-workspaces) together. This saves Gateway checkout space, not all storage used by a session's accepted changes.

While the worker is active, **Files**, file editing, and diffs inspect its actual checkout through the authenticated node connection. After Stop, retained changed-file previews and change paths remain available, but unchanged upstream files, editing, and full diffs require a running worker. The diff panel explains that the workspace is stopped. Opening these views never substitutes the agent's Gateway workspace.

After a failed placement, redispatch the session and retry the turn. A reclaimed placement redispatches automatically on the next turn. The next turn rebuilds model context from the Gateway transcript, so it continues from the messages that crossed the durability boundary.
