# Retained incident repair and controller adoption

The existing activation owner dispatches `--activate-retained-repair OPERATION BUILD_RECEIPT_SHA256` or `--resume-retained-repair OPERATION CURRENT_JOURNAL_SHA256` to the typed repair owner. It never calls the version-1 journal/rollback path. Both commands require the actual exclusive canonical FD9 lock. No Boolean enables repair.

## Reviewed config replacement on the failed candidate

A live selected candidate in `ROLLBACK_FAILED` may itself fail readiness while
an operator's native config write prevents ordinary rollback. After reviewing
the exact replacement config and original journal, prepare a distinct,
same-schema target containing the product fix:

```sh
/usr/local/sbin/openclaw-release-deploy --prepare-retained-repair \
  "$OPERATION" "$TARGET" "$CURRENT" "$PID" "$START" "$JOURNAL_SHA256" "$CONFIG_SHA256"
/usr/local/sbin/openclaw-release-deploy --activate-retained-repair \
  "$OPERATION" "$BUILD_RECEIPT_SHA256"
```

`OPERATION` is a new UUIDv4. `TARGET` is the exact official main frozen by
preparation, `CURRENT` is the failed selected candidate, and `PID`/`START` bind
its live process generation. `JOURNAL_SHA256` and optional `CONFIG_SHA256` are
the reviewed files' SHA-256 digests. Use the `completed.sha256` from successful
preparation as `BUILD_RECEIPT_SHA256`; activation consumes that exact receipt,
including its config approval, without another config argument. Omit the final
config digest when no reconciliation is needed.

Reconciliation uses the same config snapshot and native atomic-replacement audit
as `--recover --reconcile-config`, including the separate backup, unchanged
SQLite identity, live process, pointer, and journal bindings. Preparation does
not require the failed candidate to pass readiness. Activation still requires
the existing fresh maintenance lease, complete history evidence, and full target
acceptance. Neither a config digest nor a successful build waives those gates.
The original journal bytes remain archived unchanged as the existing typed
repair transaction takes over the canonical journal slot. Changed config or
incident evidence refuses continuation.

After an interrupted activation, use the same operation with the observed
canonical journal hash:

```sh
/usr/local/sbin/openclaw-release-deploy --resume-retained-repair \
  "$OPERATION" "$CURRENT_JOURNAL_SHA256"
```

These commands require the reviewed controller closure to be adopted through
the retained-incident procedure below. Publication of a PR does not authorize
controller installation or a deployment.

## Durable protocol

Canonical sequence: REPAIR_PREPARED, REPAIR_EVIDENCE_VERIFIED, REPAIR_BOUND, REPAIR_SUSPENDED, REPAIR_STOP_INTENT, REPAIR_STOPPED, REPAIR_SELECT_INTENT, REPAIR_SELECTED, REPAIR_START_INTENT, REPAIR_STARTED, REPAIR_VERIFIED, REPAIR_COMPLETED. Each transition has an exact-byte/inode intent and per-event artifact. Original failed journal, original floor, build receipt and transition evidence remain retained. No database copy, restore, rewind, successful-journal deletion or generic cleanup is added.

Binding checks actual B native PID/generation/InvocationID, runtime, cgroup, listener and stopped legacy user manager. The lease must be fresh READY with zero active work, no blockers and explicit clear write custody. No persistence or CPU waiver is accepted. Stop uses the existing committed native handoff and systemd owner. A new stopped history floor binds state after old writers, listeners and jobs have gone. C selection is crash-reconcilable per pointer.

The root PID1 `+ExecCondition` is the sole public no-FD9 entry. It validates the exact installed library, Node binary, ControlPID, service cgroup/InvocationID, canonical START_INTENT and immutable stopped capability. The final claim file is O_EXCL and durable before success; a partial claim consumes the attempt. A distinct durable start-dispatch receipt precedes the single systemctl start. Resume reconciles the existing process/job and never dispatches another start.

Strict acceptance uses the original existing native registered project `openclaw` without new `repairProject` configuration or project discovery. The original incident RPC is fixed at `projects.checkoutOptions({projectId:"openclaw",agentId:"roboclaw"})`; marker execution still preserves the configured model agent. The deployed release C is sealed and checked by the lifecycle; the project workspace need not have HEAD=C or be pristine, and is never switched, cloned or cleaned. Native `sessions.create` binds the actual project/session identity, and the exact agent payload/idempotency key is durable before dispatch. The original `projects.checkoutOptions` request with the exact original project and probe agent is sent under the same deadline, and its successful current-checkout response is retained in terminal proof. Registry/root identity, deadline, marker, requested/effective model, configured channels, no approvals, process generation and history floor must match. An exact completed receipt is reused after an interrupted acknowledgement without a second model dispatch. No shared profile, checkout, registry, model or channel mutation is part of acceptance.

VERIFIED precedes exact guard removal. A durable removal intent and completion event allow recovery after unlink or daemon-reload failure without another start. COMPLETED retains the canonical slot and all receipts. Shell failures write exact-journal observations without turning transport uncertainty into a terminal phase. Explicit lifecycle fail remains a terminal FAILED receipt with no automatic rollback/start. Neither terminal state is reusable.

## Whole-closure adoption boundary

The exceptional adoption owner binds the exact retained V1 incident, old four-file closure, approved replacement closure and actual canonical FD9 inode. An already gate-aware incumbent uses ordinary `prepare` and `apply`. An ungated V2 incumbent first uses the explicit `retained-controller-adoption bootstrap ROOT REQUEST_JSON` action from the approved off-path replacement library; it never treats a gate file, Boolean, timer stop or flock alone as reader exclusion.

Bootstrap durably archives the original journal, all four original files, approved replacements and two argument-independent fail-closed bridges. Each bridge replacement has a persisted old/stage/new inode intent: the library bridge is installed and directory-fsynced first, then the shell bridge. Only afterward does a genuine `/proc` census exclude every previously loaded canonical reader, including stopped, stdin-blocked and FD9-less readers. Unobservable process or namespace state fails closed. The exact original journal is checked again before an immutable exclusion receipt is retained; drift is never restored or rewound. Refusal leaves bridges and evidence in place for exact replay.

Ordinary adoption consumes that receipt, retains the original backups (not bridge backups), and replaces all four files using the existing exact per-step intents. First two predecessor inodes are the verified bridges; helper predecessors remain the originals. New entry gates reject every incomplete mixed closure. A private approved `.mjs` archive can resume after the original staging directory is gone. Completed admission validates retained history without requiring the canonical journal to revert to V1.

**Managed-entry/trusted-root contract:** every controller invocation, including manual readers, must use the literal canonical absolute shell or library path in argv within the same fully visible PID namespace. Relative paths, symlink/FD aliases, sourced/evaluated/imported old code, copied old code, changed process titles and deliberately hidden argv are outside this managed domain. The installer, interpreter environment, PATH and canonical ancestors are trusted/root-controlled. Trusted root must separately settle detached or crash-orphaned old children, pending native jobs and profiling work. This barrier proves canonical-reader retirement only; existing writer/listener/native-job/service custody checks remain mandatory. It makes no claim to fence arbitrary root deliberately running old copies.

Never install an arbitrary partial closure or treat repository publication as live permission. See [SOURCE.md](SOURCE.md) for the captured installed provenance, reviewed differences, and qualification limits.

## Qualification still required

Real-systemd rehearsal must cover root/PID1 entry, typed ExecConditionEx, stop-history persistence, claim/dispatch crashes, absent/repopulated user manager, listener/writer/job races, guard removal/resume and all four-file adoption interruption points. Synthetic native IO tests prove controller decisions, not operating-system contracts. Repository publication does not certify this native rehearsal. Any adoption requires its exact operator procedure and approval; this reconciliation does not access or modify the deployment host.

The protocol deliberately leaves COMPLETED/FAILED canonical journals and operation receipts in place. Retirement/new-operation policy is not inferred from age or a success log; a separately reviewed owner is required before reusing that canonical slot.
