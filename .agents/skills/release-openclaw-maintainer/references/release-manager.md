# Coordinate release owners

Use **release manager / orchestrator mode** when asked to manage several
channels, formulate release kickoffs, route hotfixes, or arrange a passoff.
For one release, use [release-owner mode](release-owner.md) directly. This is an
agent coordination role, not a new executable publisher or replacement for
`pnpm release:stable`.

## Keep one owner per release

The manager owns scheduling, release briefs, cross-channel hotfix routing, and
approval/status communication. Each release owner alone owns its branch,
candidate admission, validation, publication, and closeout. The manager never
cherry-picks into an active owner's branch, approves its workflow jobs, or
starts a competing validation/publish run.

Keep a compact session record linking to authoritative owner handoffs:

| Release/channel     | Kind/base                         | Owner/session    | Phase and run       | Publication authority       | Blocker/next action              |
| ------------------- | --------------------------------- | ---------------- | ------------------- | --------------------------- | -------------------------------- |
| `<version/channel>` | `<patch or feature; pinned base>` | `<session link>` | `<phase; run link>` | `<held or approval source>` | `<action and responsible owner>` |

Do not copy every artifact into a second ledger. Use existing session state and
handoff documents; this mode introduces no service, scheduler, or state store.
Report meaningful transitions and unresolved cross-release decisions, not
continuous duplicate status. Shared branch mutations, selectors, and publication
surfaces need serialized ownership: two releases on the same beta/stable train
cannot independently mutate the same canonical branch. Sequence them or hand
off the existing owner rather than inventing alternate cut branches.

## Formulate and start a release

1. Read the current owner lifecycle and applicable phase references. Resolve
   channel × patch/feature, optional version, source baseline, publication
   scope, and new/resume/handoff. Reuse a matching active owner rather than
   creating another. Missing version follows the owner's resolution/approval
   rule; extended-stable refresh still needs its exact approved eligible base.
2. Put only enduring mission variables in the initial message. Keep mechanics
   in the skill so “Manage this beta patch release” reaches the same process as
   a longer generated prompt. State effective authority explicitly: beta
   management includes publication unless held; stable/extended-stable wait for
   approval unless it is already granted. Never promote prepare-only authority.
3. If asked only for a prompt, return the filled brief without starting work.
   If authorized to start/manage releases, use the host's session-creation route
   for independent release sessions, or its supervised-child route when that is
   explicitly intended. Do not assume a particular session tool is available.
   Preserve session links and send scoped updates through the available
   inter-session messaging tool; absent tools, provide a copyable handoff and
   report that it has not been delivered.
4. Have the owner acknowledge its resolved release identity, authority, and
   first action. Link its handoff and watch for material transitions. A launch
   receipt is not evidence that validation or publication ran.

### Kickoff brief

Replace placeholders with verified facts; omit irrelevant fields. Do not copy
historical secrets, host topology, stale SHAs, or one-off gate exceptions.

```text
Own OpenClaw <version, or resolve next version> on <channel> through the
release-owner lifecycle in $release-openclaw-maintainer.
Kind: <patch | feature>. Base: <verified tag/branch/SHA or resolution rule>.
Mode: <new | resume | handoff>; existing owner record: <link or none>.
Preparation scope: <approved fixes/selection authority; excluded changes>.
Intake: <open until checkpoint | frozen; conditional additions if any>.
Publication: <beta management authority | held pending approval | exact prior approval>.
Selected surfaces: <track defaults plus explicit selections/exclusions>.
Manager: <session link or none>; report hotfix dispositions and blockers here.
Continue through required validation, authorized publication, artifact
verification, applicable main closeout, retrospective/issue ledger, and cleanup.
Keep the current run and outstanding failures/fix PRs visible. Preserve completed
evidence and release identity; escalate only concrete decisions or access blockers.
```

Examples of short requests (not permission to act on these examples):

- “Manage the next beta patch release; choose the next unused beta number.”
- “Prepare a stable feature promotion from this beta; hold publication.”
- “Prepare the eligible extended-stable refresh from this approved stable tag.”
- “Take over this release using its handoff; publication was approved here: `<link>`.”

The manager expands these through the same lifecycle, not separate
channel-specific copies of the runbook. Record later operator steering in the
owner's effective goal; do not preserve superseded constraints merely because
they appeared in the initial prompt.

## Route hotfix opportunities once

Maintain one cross-channel disposition row per canonical fix or dependent fix
group, linking each owner's backport ledger. Pin a shared discovery scan so
owners can reuse upstream investigation, while each checks its own baseline.
Send to every active channel for assessment; “all channels” does not mean the
same patch applies unchanged or must ship in every already-frozen candidate.

```text
Hotfix opportunity: <canonical merged main commit/PR, or repair owner if not merged>.
Impact: <broken behavior, affected versions, urgency and evidence>.
Fix group: <ordered commits/companions; upstream proof>.
Requested disposition: <assess | include under linked approval | next release>.
Timing: <before freeze | only if an admitted blocker forces new C/Q | next release>.
Authority: <operator instruction, or assessment only>.
Reply with included / queued / not-affected / blocked, reason, candidate SHA
if included, and evidence invalidated or required. Do not reopen intake merely
because this message arrived.
```

Deduplicate main fixes and assign one repair owner; do not ask three release
owners to author the same fix. Once landed, route its canonical identity and
companions. Owners retain line-specific compatibility and risk decisions;
escalate disagreements with concrete evidence. Keep security details in their
approved private workflow. Missing response means unconfirmed, not included.

For a late urgent fix, present which candidates would change, invalidated proof,
and the alternative of the next patch. Relay the operator's decision to affected
owners. Do not cancel other releases, re-cut bases, or broaden publication
approval as a side effect. Coordinate shared npm selectors and stable beta-sync
with the existing publication rules; never move a newer beta backward.

## Route approvals, handoffs, and closeout

Batch each owner's ready-to-publish summary for the operator without merging
separate release approvals. Forward the decision and its scope to the correct
owner; already-granted authority persists through recovery and handoff.

For a passoff, obtain the existing handoff and retrospective snapshot, identify
in-flight work, stop the predecessor's writes, and send the successor the kickoff
brief plus current state. Require acknowledgement before routing more mutations.
When the predecessor is unavailable, reconcile live state and explicitly retire
its ownership before continuing. Do not redispatch uncertain operations.

A credential failure routes the precise operation to an authorized capable
owner, not to alternate credentials that bypass a refusal. Independent work can
continue. The manager's progress view names who must unblock the remaining step.

At closeout, reconcile each owner's verified result, selected pending surfaces,
retro/ledger PR, repair PR disposition, cleanup, and deferred-hotfix owner.
Deduplicate shared lessons and follow-ups; per-release retrospectives retain
their own evidence. Do not report the campaign complete while a release is
merely dispatched, waiting for approval, or awaiting an unacknowledged handoff.
