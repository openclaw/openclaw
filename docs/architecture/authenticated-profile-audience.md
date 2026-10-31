---
title: "Authenticated profile audience proposal"
summary: "Proposed separation of authenticated profile ownership, session personalization, and audience-safe delivery"
read_when:
  - Reviewing personal instructions in collaborative conversations
  - Defining person-scoped Knowledge and history access
---

# Authenticated profile audience proposal

**Status: partial bootstrap/tool implementation and proposed wider contract.** The
review slice below is implemented in this draft; the remaining behavior and
interfaces require owner decisions. This does not establish full person-level
privacy or complete
[#186068](https://github.com/openclaw/openclaw/issues/186068).

## Implemented review slice

The code in this draft omits automatically selected personal USER.md overlays
from group, channel, cron, and subagent bootstrap contexts before opening those
files. The final common bootstrap filter also removes personal-marked sources
added by hooks. Shared defaults and existing subagent/cron file allowlists stay
in place. Session profile selection and authenticated Settings self-editing are
unchanged. Authoritative chat type still overrides session-key classification.

The canonical personal-file handler also refuses agent-tool reads and saves for
known group/channel origins or destinations before accessing the file. It uses
the existing host-captured requester origin and execution session key, not new
model arguments. Group-origin delegation cannot evade the check by moving into a
direct-looking execution session. Both get and set return content, so both are
restricted; users retain the private Settings editor.

This is deliberately smaller than the contract below. It does not implement
private-audience admission for shared web tasks, confine raw files, or change
Knowledge/LCM grants or retained history. Direct or unknown classifications retain
their existing behavior and are not evidence of a person-private audience.

## Existing foundation

Reuse the [human profile and personal USER.md owners](/concepts/user-model).
Authenticated members already have self-service profile editing, including
session-scoped access ([#179924](https://github.com/openclaw/openclaw/pull/179924),
[#184980](https://github.com/openclaw/openclaw/pull/184980)). Personal instructions
remain in the configured agent workspace, not the task worktree. The workspace-root
USER.md remains shared defaults. No second writable profile registry is proposed.

Preserve the current selection: assigned human owner first, otherwise authenticated
human creator. The authenticated requester independently determines the editor and
execution permissions. Another sender must not silently replace session selection.

[#186455](https://github.com/openclaw/openclaw/pull/186455) adds conversation grants
to an **agent-private** Knowledge partition. Reuse that capability without treating
the agent-private partition or the existing owner-private memory audience as
authenticated-person isolation.

## Proposed first-stage behavior

### Separate selection from admission

The host would admit a selected personal overlay only when it can establish that
the conversation's intended human audience is that canonical person. The host
must define this using existing identity and session sharing/access owners, not
names, model-supplied IDs, or a direct-looking session key. Trusted administrators
and host access remain outside any hostile-tenant secrecy claim.

Groups, channels, publicly shared or collaborative sessions, mixed-person batches,
and unverifiable audiences would receive shared defaults only in this first stage.
The selected profile would stay recorded when its overlay is withheld.

| Conversation                           | Selected profile              | Proposed personal context                                                    |
| -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Alice's person-private conversation    | Alice                         | Shared defaults, then Alice, after live admission                            |
| Bob's person-private conversation      | Bob                           | Shared defaults, then Bob, after live admission                              |
| Alice-assigned task shared with Bob    | Alice, unchanged              | Shared defaults only; do not substitute Bob                                  |
| Group or channel, regardless of sender | Existing selection, unchanged | Shared defaults only                                                         |
| Missing or unresolved audience         | Existing selection, if any    | No personal overlay                                                          |
| Internal continuation                  | Existing selection            | Only if retained host authority still establishes the same admitted audience |
| Delegated agent                        | Existing subagent policy      | No personal USER.md, as today                                                |

Recognizing Bob would use host-verified per-turn requester facts. Preferences Bob
explicitly expresses in the shared conversation could guide that response without
reading his private file or replacing session selection. This proposal does not
add field-level sharing or a second store for shareable preferences.

Audience changes must invalidate retained personal context through its existing
owner. Preserve prompt-prefix stability: requester facts belong to the current
turn; do not rewrite earlier prompts or history. If a harness cannot withdraw
previous context safely, it is not qualified for that transition.

### Include personal-tool results in the boundary

The authenticated Settings editor would retain its existing self-scoped file API,
role/agent ceilings, canonical identity resolution, content-hash conflict detection,
safe-file rules, and final-write authority checks. Its response goes to that
person's editor rather than the shared transcript.

The chat tool is a different delivery path: `personal_instructions` with action
`get` returns profile content, and `set` returns the saved content. Either can expose instructions
through shared tool history even if bootstrap is filtered.

The proposed first stage would allow these chat operations only when their
response has person-private admission for the authenticated editor. Shared or
unqualified turns would direct the person to the existing Settings editor instead
of reading their file into the conversation. Asking for a self-edit would not
implicitly consent to publishing the whole file.

**This narrows existing chat behavior and requires host/profile-owner agreement.**
Keep the canonical editor and stable tool schema; use the execution/admission
owner for current disclosure checks. Do not introduce another authentication or
confirmation-token protocol.

### Keep Knowledge and history with their owners

Knowledge would consume host-issued person/audience authority separately from the
session-selected profile. Reads would compose that person's private material and
explicitly admitted shared material, not silently acquire the entire agent-private
partition. Settle this dependency in
[#186067](https://github.com/openclaw/openclaw/issues/186067), not in a competing
profile or grant registry here.

Record, evidence, revision, and history IDs are locators, not grants. Denial must
cover restricted content and metadata, including titles, counts, cursors, graph
paths, automatic context, and cached results. Existing owners must check current
authority before releasing asynchronous results and after revocation or restart.

LosslessClaw would qualify ordinary history, explicit-ID expansion, delegated
expansion, compaction, and restart through supported APIs. Knowledge must not read
LCM's private database. Withholding a new overlay does not sanitize previously
delivered history. Its owner must define safe handling; no silent deletion,
history rewrite, or history-losing fork is proposed.

### Qualify capabilities, not just prompts

Start with one existing restricted Gateway/tool/mount configuration. Task
workspace operations may remain available, but enabled file, shell, native,
artifact, evidence, and history paths must not reach non-admitted personal roots.
A read-only mount is not a read-disclosure boundary, and a self-service API pass
does not certify generic file access.

Reuse sandbox, file-access, and harness owners. Do not add Knowledge-only path
filtering that other tools bypass. A combination unable to enforce the boundary
would remain unsupported for this privacy claim. No operating-system tenant
isolation from one shared Gateway is promised.

Inferred person views would remain attributable Knowledge records with their
evidence's restrictions. Scribes, recall, synthesis, and autonomous/delegated jobs
would receive no capability to promote them into USER.md. Explicit user-requested
self-edits would retain the canonical editor path; inferred records would not
override user-authored directives. Prompting an unrestricted file writer to comply
is not sufficient proof. All enabled mutation paths must satisfy this boundary.

## Proposed implementation

Except for the implemented bootstrap/tool slice above, this remains a proposed code
design, not runtime code shipped by this PR. The owner map was
checked against main at
[7861f59337f9](https://github.com/openclaw/openclaw/commit/7861f59337f9163040c9ccfb1c1f682ede689e27).
Refresh the actual implementation checkout before coding; do not revive retired
recovery helpers or assume the earlier 93-test checkout is current main.

### Owner and file map

| Responsibility                        | Existing owner to extend                                                                                                                     | Proposed change                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical person and self-edit target | Profile catalog and `users-personal-file.ts`                                                                                                 | Keep the authenticated editor, alias resolution, scopes, workspace binding, and final mutation guard; do not choose the editor from session selection                               |
| Intended audience and live authority  | `src/gateway/session-sharing-policy.ts`, `session-sharing-read.ts`, and `session-access-authority.ts`                                        | Classify the audience from resident sharing/role facts and bind its lifetime to the admitted source; a successful single-viewer access check is not proof that nobody else may read |
| Run-level carriage                    | `src/agents/admitted-run-context.ts` and existing harness host capabilities                                                                  | Carry one host-issued admission with the prepared run and close it with that run; no persisted capability, new nonce protocol, or competing manager                                 |
| Stable selected profile               | `sessionPersonalProfileId`, reply/queued-turn preparation, and `src/agents/command/attempt-run-params.ts`                                    | Preserve selection; forward disclosure admission separately rather than assigning the sender to `bootstrapUserProfileId`                                                            |
| Bootstrap and rendering               | `src/agents/bootstrap-files.ts`, `workspace-personal-bootstrap.ts`, and `harness/workspace-context.ts`                                       | Admit before opening a personal file and before releasing its context; keep shared defaults, budgets, provenance, alias guards, and subagent exclusions                             |
| Chat self-edit response               | `src/agents/tools/personal-instructions-tool.ts`, `tools/gateway-caller-context.ts`, and `src/gateway/server-methods/users-personal-file.ts` | Apply disclosure admission to agent-tool invocations without narrowing the private Settings connection's existing self-service rights                                               |
| Raw capabilities                      | `src/agents/core-coding-tools.ts`, `agent-tools.read.ts`, and existing sandbox/mount owners                                                  | Qualify a configuration that does not expose sensitive host roots through general file/native/shell paths; do not add a parallel Knowledge-only filter                              |
| Person-private and shared recall      | `src/plugins/memory-provider-types.ts` and Knowledge's `access.ts`, `stores.ts`, and provider owner                                          | Consume the separately approved person/audience grant from #186067; do not turn profile admission into a Knowledge grant                                                            |
| Conversation history                  | Supported host context-engine boundary and LCM-owned public expansion handlers                                                               | Pin the actual supported API with the LCM owner before implementation; do not invent a private-database adapter                                                                     |

### Illustrative internal admission contract

The minimum candidate contract is one host-issued result, separate from both the
requester's authenticated authority and the selected profile:

```typescript
type PersonalContextAdmission =
  | {
      kind: "person-private";
      audienceProfileId: string;
      assertCurrent(): void;
    }
  | {
      kind: "withheld";
      reason: "shared-audience" | "unverified-audience";
    };
```

This name and shape are proposed, not an existing SDK export or callable tool.
The host's admission owner must mint the trusted value; callers must not accept a
lookalike object from model input, a transcript, a plugin payload, or saved state.
Use the existing prepared-source lifecycle and resident profile/sharing facts,
not a second identity table or a database reread before each operation. Any
necessary public SDK expansion needs its owning review before implementation.

The bootstrap consumer compares the canonical selected profile with
`audienceProfileId`. The personal-tool consumer instead compares its canonical
authenticated editor with that audience. Neither comparison replaces the other
identity. A missing admission withholds personal model context; it must not fall
back to agent-private authority.

### Data flow and failure behavior

1. At trusted ingress, resolve the authenticated person and the session through
   their existing owners. Preserve original authority while preparing sharing
   facts, then classify the intended audience. Include authorized readers and
   share links, not merely currently connected participants. The host owners must
   accept the treatment of broad operator access; creator, owner, and a
   `direct` chat label alone do not establish a private audience.
2. During run preparation, compute session selection as today. Carry that selected
   ID and the separate host admission through queued turns, command entry points,
   the embedded runner, generic CLI, and native adapter. Reuse the same admission
   on retries; do not mint fresh authority or inherit it into delegated children.
3. Before `loadPersonalUserBootstrapFile` opens the selected file, require matching
   personal admission and assert its current authority. Recheck after the file
   read and before returning model context. At the existing post-hook boundary,
   prevent loader-marked personal sources from being reintroduced after admission
   was withheld. Arbitrary trusted plugin code remains inside the trusted-host
   boundary; this is not isolation from a malicious host plugin.
4. For agent-tool `users.personalFile.get/set`, retain current requester/role/agent
   guards and additionally check the response audience. Reject an unqualified
   shared-context edit before mutation, not after writing and returning an error.
   Recheck at the existing final-write guard and before returning content. The
   direct authenticated Settings API retains its current self-scoped behavior.
   Give shared-chat users the Settings route instead of a generic file fallback.
5. Before a harness submits or reuses personal context, recheck admission through
   the run owner. Invalidate its existing prepared context on an audience change.
   Native threads that cannot withdraw inherited instructions or private-bearing
   history must not continue under the widened audience. Do not silently rewrite
   past prompts, discard history, or move private material into a fork.
6. Withheld bootstrap falls back to shared defaults and records a bounded reason
   without personal content, paths, hashes, or a list of other people. An expired
   admitted capability stops the affected delivery/mutation through existing
   authorization errors; it does not authorize a fresh subject or broader grant.

### Change order and rollout

1. **Agree the contract and qualify existing composition.** Resolve the named
   owner decisions and #186065's actual Knowledge/LCM continuity qualification.
   Identify one real restricted Gateway setup and the first supported harness;
   do not start schema, permission, or per-person partition changes from this
   documentation PR.
2. **Implement one host cutover after agreement.** Add admission in the existing
   source owner, bootstrap consumer, personal-tool response owner, and every
   affected bundled entry point together. Preserve private Settings self-edits
   and session selection. Qualify embedded execution first, but do not transfer
   its pass to CLI/native/delegated paths. An unqualified adapter must withhold
   personal delivery or reject the affected operation, rather than inherit a
   profile through an unsafe carrier. Do not add a new configuration flag here.
3. **Implement and integrate the dependent recall boundary.** #186066/#186067
   own the accepted person/shared-grant and LCM changes. Only their integrated
   positive/negative evidence permits #186068 to claim the combined scenario.
   This is sequencing, not a claim that four implementation jobs are running.

A private-to-shared transition is a separate gate, not just a prompt refresh.
If the history owner cannot establish that old content is safe for the new
readers, the recommended first stage is to reject widening that conversation
and offer a fresh shared conversation with no private history copied. This
restriction itself needs owner acceptance. Do not create a second provenance
ledger merely to assert safety that the existing history owner cannot prove.

There is no personal-file migration or deletion in the host cutover. On missing
admission, keep shared defaults and the existing private Settings editor working.
Rolling back code is not a repair for private text already delivered to a wider
audience; record that as an unresolved disclosure outcome, not a successful
rollback or a promise of erasure.

### Concrete regression plan

Extend existing owner suites rather than creating another test profile registry:

| Existing seam                                                                                                      | Required new or retained assertion                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/gateway/session-access-authority.test.ts` and sharing suites                                                  | Mint only from admitted host facts; withhold public/collaborative/unknown audiences; invalidate an admitted delivery after sharing, alias, or role changes                       |
| `src/agents/bootstrap-files.personal.test.ts` and `harness/workspace-context.test.ts`                              | Prove shared-plus-selected ordering in admitted private context, no personal file open/release for a shared audience, and no post-hook reinjection of protected personal sources |
| `src/auto-reply/reply/queue.personal-bootstrap.test.ts` and overflow suite                                         | Mixed senders preserve selection but do not retain a private admission for the collected audience                                                                                |
| `src/gateway/server-methods/users-personal-file.test.ts` and `server.personal-instructions.session-scopes.test.ts` | Separate real Alice/Bob Settings edits from chat-result delivery; reject a shared-context chat edit before writing; final revocation leaves both files unchanged                 |
| File-tool/sandbox owner suites                                                                                     | Allowed task-file access still works; every enabled direct route to a denied personal root fails without returning its bytes or metadata                                         |
| CLI and native adapter suites                                                                                      | Inspect the actual outgoing carrier and retained-thread behavior; preserve current unsupported-path omissions instead of interpreting them as successful personal delivery       |
| Knowledge provider/index/grant suites and the LCM public-API fixture                                               | Distinguish agent-private room grants from person-private scope; deny explicit IDs, cached results, and delegated expansion after revocation and restart                         |

Keep unchanged selection regressions green on both base and candidate. Each new
privacy regression must fail at its relevant original boundary and pass with the
actual implementation, not fail during setup. A retained hash or an error response
alone is not a final-effect assertion; inspect withheld output and unchanged
files through their owning APIs.

A representative focused host command after implementation would be:

```bash
node scripts/run-vitest.mjs   src/gateway/session-access-authority.test.ts   src/agents/bootstrap-files.personal.test.ts   src/agents/harness/workspace-context.test.ts   src/auto-reply/reply/queue.personal-bootstrap.test.ts   src/gateway/server-methods/users-personal-file.test.ts   src/gateway/server.personal-instructions.session-scopes.test.ts   src/agents/agent-tools.prefix-stability.test.ts --maxWorkers=1
```

That command is a proposed regression selection, not an executed result of this
PR. It must be followed by the real two-person product fixture below, relevant
adapter/file-tool tests, scoped typing/lint/format, and exact-head PR CI. Live
Knowledge/LCM compaction and restart, each claimed harness, and Windows need their
own receipts. Do not reuse the old 93 passes as evidence for these new behaviors.

## Owner decisions and implementation gate

1. **Host/profile and security owners:** accept or amend the person-private
   admission rule, intended-audience definition, overlay withholding, and narrowed
   shared-chat tool behavior.
2. **Host authority and Knowledge owners:** define person-private plus shared
   grants and revocation without equating agent-private grants with person privacy.
3. **LosslessClaw and harness owners:** define supported expansion and retained
   context-withdrawal paths, including already-delivered history.
4. **Filesystem/sandbox owners:** name the restricted tool/mount configuration
   that can actually enforce the claimed boundary.

Keep the
[#186065](https://github.com/openclaw/openclaw/issues/186065) →
[#186066](https://github.com/openclaw/openclaw/issues/186066) →
[#186067](https://github.com/openclaw/openclaw/issues/186067) →
[#186068](https://github.com/openclaw/openclaw/issues/186068) dependency chain open
until each scenario has qualifying evidence. Agreement on this document would not
itself prove prerequisite integration or authorize a merge or deployment. No new
schema, role, configuration, retention, or permission mechanism is implemented.

## Required qualification after agreement

Use real, separately authenticated Alice/Bob profiles in the existing registry,
their existing personal files, distinct private sentinels, shared defaults, an
explicitly admitted shared fact, both private conversations, and a shared task.

- Prove allowed self-edits and denied other-profile edits through Settings and
  the private chat tool separately, including conflicts, revocation, and merges.
- Prove the selection/admission matrix and shared-plus-selected ordering. Changing
  the sender or sharing a session must withhold content without selecting another
  person.
- Assert no denied content or metadata in shared bootstrap, tool results, replies,
  transcript views, and explicit/delegated history expansions. Test an allowed
  counterpart for every denied path.
- Prove person-private plus shared Knowledge separately from agent-private grants;
  repeat after revocation, restart, compaction, and retained-cache use.
- Exercise every enabled raw file/history/evidence path and automated USER.md
  mutation through the real owners. Prompt omission alone is not a privacy pass.
- Record each harness and operating system actually executed. Embedded, generic
  CLI, managed native, external native, delegated, ACP, realtime, remote worker,
  Linux, and Windows are separate claims; name unsupported and unexecuted paths.

Existing profile and partition regressions are baseline evidence only. They must
not be presented as a passing implementation of this proposed combined boundary.
