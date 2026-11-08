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

Read the incident bindings together before preparation; do not reuse values
from an earlier process or journal:

| Argument                 | Source                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPERATION`              | A new UUIDv4, retained for preparation, activation, and resume.                                                                                                            |
| `TARGET`                 | Full commit SHA on the verified official main mirror, containing the product fix. Preparation freezes official origin evidence and requires a distinct same-schema target. |
| `CURRENT`                | Full candidate SHA in the retained journal, matching the selected `current` release and live Gateway working directory.                                                    |
| `PID`                    | `MainPID` of the canonical system Gateway service.                                                                                                                         |
| `START`                  | Field 22 of `/proc/$PID/stat` (start ticks), parsed after the final closing parenthesis of the process name.                                                               |
| `JOURNAL_SHA256`         | SHA-256 of the reviewed original canonical `journal/activation.json`.                                                                                                      |
| `CONFIG_SHA256`          | SHA-256 of the reviewed config at the journal's first protected path. Omit only when reconciliation is unnecessary.                                                        |
| `BUILD_RECEIPT_SHA256`   | `completed.sha256` in successful preparation's JSON output. Activation inherits its exact config approval without another config argument.                                 |
| `CURRENT_JOURNAL_SHA256` | On resume, a fresh SHA-256 of the current canonical journal, after reviewing its interrupted phase. This is not the original incident hash.                                |

Use the deployment owner's existing private environment and operator profile.
Preparation requires disabled, inactive deployment timers and the original live
candidate generation; it builds off-path and does not need a load flag.
`--allow-cpu-degraded` is intentionally invalid for retained preparation and
activation. Target verification already accepts CPU/utilization-only warnings
with bounded event-loop delay through the normal deployment acceptance policy;
it never waives readiness, delayed event loops, or marker verification.

Reconciliation uses the same config snapshot and native atomic-replacement audit
as `--recover --reconcile-config`, including the separate backup, unchanged
SQLite identity, live process, pointer, and journal bindings. Preparation does
not require the failed candidate to pass readiness. Activation still requires
the existing fresh maintenance lease, complete history evidence, and full target
acceptance. Neither a config digest nor a successful build waives those gates.
The original journal bytes remain archived unchanged as the existing typed
repair transaction takes over the canonical journal slot. Changed config or
incident evidence refuses continuation.

### Transcript continuity after serving traffic

Retained preparation accepts historical session windows after repeated resets or
rotations when the original physical database, window owner, and exact rewrite
generation remain. The current session entry need not still directly reference
every historical window. An exact immutable archive with a verified encoded hash
also preserves its saved generation.

A completed native `agent_deletion_journal` row can explain intentional loss for
its exact agent and database path. The deletion must have started no earlier than
the original activation journal, have a retiring or legacy-null phase and a
completed purge, and retain its operation identity. An existing database must
still have the witnessed physical identity; an absent file also requires
`delete_files = 1`. Pending deletion, missing or unrelated records, replaced
databases, and an unexplained disappearance remain refusals. Preparation and
later repair checks consume the same native evidence; they never manufacture it.

The native deletion journal records initial intent in `created_at` and completion
as `cleanup_completed`; it has no completion timestamp. Recovery can finish an
older intent after activation. An older intent therefore cannot establish the
ordering needed for the deletion exemption, but it does not reject preservation
through an exact archive. In the unchanged witnessed database, the ordinary
continuity check still accepts each saved session, window key and generation
whose nonempty encoded archive has a supported encoding and matching SHA-256.
Missing or corrupt archives remain refusals when the deletion exemption is
unavailable. Archive creation and publication timestamps are not deletion
completion timestamps; neither filesystem modification time nor a later
observation of `cleanup_completed` establishes that ordering.

Rewrite generations are random tokens, not ordered counters. For fix-forward
from the still-selected failed candidate, preparation also accepts its
post-incident rewrites: the database device/inode, session ID and window key
must match the original witness, both session nodes must still select that
window, and the watermark's integer `updated_at` must be strictly after the
journal's `createdAt` and no later than observation. Existing preparation checks
bind both the selected release pointer and live process cwd to that candidate.
This is explained evolution by the serving candidate, not recovery of the old
bytes; the invariant is no unexplained transcript loss relative to what the
candidate itself produced. A timestamp alone is insufficient.

The sealed build witness binds the accepted generation. Later activation checks
may recognize that same generation after selecting the repair target, but cannot
accept another rewrite against the captured build, preparation or stopped floors.
Original historical windows absent from the build witness retain their exact
generation/archive requirement. Predecessor selection and rollback do not receive
this exception; neither does a native restore or changed database identity.
Do not edit watermarks, deletion records, or the original witness to satisfy this
guard. The operator must diagnose missing evidence before proceeding.

### Native config audit evidence

The Gateway's `agents.delete` path uses the normal atomic config writer. That
writer automatically records a `config.write` event with `source: "config-io"`
and `result: "rename"` in the shared state database's `diagnostic_events` table,
under `scope = 'config-audit'`. No special RPC label or operator-created artifact
is required. The controller reads the newest 50,000 rows in that scope and
binds each accepted row's key and payload hash.

Reconciliation requires a contiguous chain of at most 64 replacements, in native
sequence order, from the original journal's device/inode to the reviewed config.
Each link's previous hash, byte count, device and inode must equal the preceding
link's next values. Timestamps must be monotonic, at or after journal creation,
and not in the future. Gaps, forks, reordered links, foreign sources and
non-rename writes refuse reconciliation. Native read-only `config.observe` rows
are skipped; observations reporting backup restoration are not. Identical-byte replacements still
require inode continuity. The final next hash, byte count and device/inode must
match the reviewed config; the final previous hash and byte count must match the
separate current `<config>.bak`. Earlier backups need not remain.

Both sides of every link have mode `0600`, one link, the runtime UID, and the
current config GID. Each row requires the exact config path, `existsBefore: true`,
a positive PID, and an `event_key` beginning with `<timestamp>:config.write:`.
The native writer's recorded cwd must be the journal's candidate release and its
argv must be the controller's Gateway launch command, using either that release's
entry point or the managed `current` entry point. Historical Gateway PIDs may
differ after restarts; their persisted native process metadata supplies provenance,
while the existing separate live-generation check still binds current authority.
Both config files remain safe regular files on the original filesystem. Ordinary
startup-only additive migration acceptance remains limited to one replacement by
its exact newly started process within its existing ten-minute window.

Audit persistence is best-effort: a successful native RPC alone does not prove
the complete chain exists. If reconciliation reports a missing native atomic-replacement
audit, inspect the existing rows and backup against those bindings. A later
foreign replacement, mismatched backup, or failed audit write can explain the refusal.
Do not manufacture/import a row, repeat `agents.delete`, or edit the journal
to satisfy it. Missing or mismatched evidence remains a recovery blocker for
the operator to diagnose; the config digest does not bypass this guard.

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

## Retire a completed repair

After successful activation, review the exact `REPAIR_COMPLETED` journal and its
acceptance receipt, then release the canonical slot through the same deployer:

```sh
/usr/local/sbin/openclaw-release-deploy --retire-retained-repair \
  "$OPERATION" "$COMPLETED_JOURNAL_SHA256"
```

`OPERATION` is the activation's UUID. `COMPLETED_JOURNAL_SHA256` is the SHA-256
of the reviewed completed `journal/activation.json`, not the incident or build
receipt hash. Use the same adopted controller closure and private operator
environment as activation. This action requires the exclusive existing FD9 lock;
it cannot be combined with another action or waiver.

The owner validates the completed transaction and consumes the immutable receipt
already accepted by activation. It binds the target SHA to the selected release
and live cwd, exact PID/start generation and native invocation, recorded
current/previous pointer identities, and canonical lock inode. Drift, a missing
or changed acceptance receipt, or any phase other than `REPAIR_COMPLETED` refuses
retirement. It does not rerun a marker, restart the Gateway, or alter a database.

The private archive `journal/retired-repair-<OPERATION>/` receives durable copies
of that operation's repair artifacts and an `intent.json` binding their exact
source and archive descriptors. Original artifacts remain at their bound paths:
existing receipts refer to those absolute paths and inodes. After rechecking live
custody, pointers, journal and lock, one atomic rename moves the unchanged journal
to `activation.json` inside the archive. Both parent directories are fsynced;
`retirement.json` is then durably published and emitted as the JSON receipt.
No evidence is deleted and no retention policy changes.

If interrupted, repeat the **same command with the same completed hash**. Before
the rename it revalidates the original completed transaction; afterward it checks
the archived journal, artifacts, acceptance and recorded live bindings, finishes
durability, and emits the same receipt. A new canonical journal refuses replay.
An absent slot after the rename is safe for ordinary admission because the whole
evidence bundle and intent precede it. Successful retirement permits a separately
approved ordinary deploy; it does not authorize that deploy or enable a timer.
Never use ordinary `--recover`, unlink the journal, or retire `REPAIR_FAILED`.

## Whole-closure adoption boundary

The exceptional adoption owner binds the exact retained V1 incident, old four-file closure, approved replacement closure and actual canonical FD9 inode. An already gate-aware incumbent uses ordinary `prepare` and `apply`. An ungated V2 incumbent first uses the explicit `retained-controller-adoption bootstrap ROOT REQUEST_JSON` action from the approved off-path replacement library; it never treats a gate file, Boolean, timer stop or flock alone as reader exclusion.

When the fixed gate completed for an earlier incident, use the explicit
`historical-successor` action from the approved replacement library. Its request
contains exactly `{version:1,operation,source,oldClosure,replacement,historical}`,
where `historical` is `{gate,complete}`. Every descriptor is
`{path,device,inode,sha256}`; both closure arrays contain the shell, library,
suspension helper, and startup helper in that order. `source` binds the current
retained V1 `ROLLBACK_FAILED` journal and must differ from the historical source.
`oldClosure` binds all four actual installed files, independently reviewed even
if a later ordinary installation differs from the old completion's output.
`replacement` binds the four approved staged files. Historical adoption cannot
be combined with accepted-incident retirement or bootstrap.

```sh
node "$STAGE/release-lib.mjs" retained-controller-adoption historical-successor "$ROOT" @stdin < request.json > binding.json
node "$STAGE/release-lib.mjs" retained-controller-adoption apply "$ROOT" @stdin < binding.json > adopted.json
node "$STAGE/release-lib.mjs" retained-controller-adoption context "$ROOT" @stdin < binding.json
```

Hold the existing exclusive FD9 lock across these commands. The owner validates
the historical completion's immutable intent, archives, and replacement steps
without treating its source or closure as current authority. It separately
checks the current source, lock, actual installed closure, ownership, modes, and
audited entry hooks. Protocol markers identify separately audited code; they do
not replace review of the exact four incumbent hashes. Ordinary `prepare` and
entry admission retain their current-closure requirements.

The existing owner archives the unchanged old gate and actual incumbent files,
then publishes the successor gate and four replacements through its existing
durable intents. An interruption replays the same `historical-successor` request
and returned binding through `apply`; preserve the original staging inodes,
operation, source, lock, and all history. No gate deletion or manual installation
is part of recovery. After completion, the installed shell can prepare the new
retained repair; preparation still owns process, target, and native config-audit
admission. Historical completion grants no lifecycle or config authority.

Bootstrap durably archives the original journal, all four original files, approved replacements and two argument-independent fail-closed bridges. Each bridge replacement has a persisted old/stage/new inode intent: the library bridge is installed and directory-fsynced first, then the shell bridge. Only afterward does a genuine `/proc` census exclude every previously loaded canonical reader, including stopped, stdin-blocked and FD9-less readers. Unobservable process or namespace state fails closed. The exact original journal is checked again before an immutable exclusion receipt is retained; drift is never restored or rewound. Refusal leaves bridges and evidence in place for exact replay.

Ordinary adoption consumes that receipt, retains the original backups (not bridge backups), and replaces all four files using the existing exact per-step intents. First two predecessor inodes are the verified bridges; helper predecessors remain the originals. New entry gates reject every incomplete mixed closure. A private approved `.mjs` archive can resume after the original staging directory is gone. Completed admission validates retained history without requiring the canonical journal to revert to V1.

**Managed-entry/trusted-root contract:** every controller invocation, including manual readers, must use the literal canonical absolute shell or library path in argv within the same fully visible PID namespace. Relative paths, symlink/FD aliases, sourced/evaluated/imported old code, copied old code, changed process titles and deliberately hidden argv are outside this managed domain. The installer, interpreter environment, PATH and canonical ancestors are trusted/root-controlled. Trusted root must separately settle detached or crash-orphaned old children, pending native jobs and profiling work. This barrier proves canonical-reader retirement only; existing writer/listener/native-job/service custody checks remain mandatory. It makes no claim to fence arbitrary root deliberately running old copies.

Never install an arbitrary partial closure or treat repository publication as live permission. See [SOURCE.md](SOURCE.md) for the captured installed provenance, reviewed differences, and qualification limits.

## Qualification still required

`retained-repair-native-config.test.mjs` exercises reviewed-config preparation,
archived-journal activation, resume, and the installed root/PID1 start condition
using real systemd and a synthetic HTTP application. It also refuses a late
config replacement before execution and refuses completion without target
acceptance. The ordinary standalone suite skips this service-mutating test.
Run it only in a fresh disposable Docker container with systemd as PID 1,
writable private cgroup v2, the standalone test prerequisites, `systemctl`,
`busctl`, `ss`, and `curl`. There must be no Gateway unit or installed controller
closure; copy the test sources to a separate root-owned directory first.

Inside that disposable container, create the explicit test sentinel and run:

```sh
printf '%s\n' retained-repair-config > /run/openclaw-controller-disposable-proof
OPENCLAW_CONTROLLER_NATIVE_PROOF=1 node --import ./test-environment.mjs \
  --test ./retained-repair-native-config.test.mjs
```

The test installs and removes only its synthetic service and closure. Destroy
the container afterward. This is start-condition proof, not a live Gateway or
model-acceptance rehearsal.

Real-systemd rehearsal must cover root/PID1 entry, typed ExecConditionEx, stop-history persistence, claim/dispatch crashes, absent/repopulated user manager, listener/writer/job races, guard removal/resume and all four-file adoption interruption points. Synthetic native IO tests prove controller decisions, not operating-system contracts. Repository publication does not certify this native rehearsal. Any adoption requires its exact operator procedure and approval; this reconciliation does not access or modify the deployment host.

Activation deliberately leaves COMPLETED/FAILED canonical journals and operation
receipts in place. Only the explicit completed-repair retirement above releases
a successful slot; age, a success log, or ordinary recovery grants no retirement
authority. FAILED remains retained for diagnosis.
