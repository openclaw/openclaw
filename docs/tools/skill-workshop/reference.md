---
summary: "Skill Workshop Gateway methods, on-disk storage layout, migration, and hard limits"
title: "Gateway methods, storage, and limits"
read_when:
  - You are calling the skills.proposals.* or skills.workshop.* Gateway methods
  - You need the Workshop on-disk layout or its migration behavior
  - You are hitting a Workshop size or count limit
---

## Gateway methods

| Method                             | Scope            |
| ---------------------------------- | ---------------- |
| `skills.proposals.list`            | `operator.read`  |
| `skills.workshop.read`             | `operator.read`  |
| `skills.proposals.inspect`         | `operator.read`  |
| `skills.proposals.historyStatus`   | `operator.read`  |
| `skills.proposals.historyScan`     | `operator.admin` |
| `skills.proposals.create`          | `operator.admin` |
| `skills.proposals.update`          | `operator.admin` |
| `skills.proposals.revise`          | `operator.admin` |
| `skills.proposals.requestRevision` | `operator.admin` |
| `skills.proposals.apply`           | `operator.admin` |
| `skills.proposals.reject`          | `operator.admin` |
| `skills.proposals.quarantine`      | `operator.admin` |
| `skills.curator.status`            | `operator.read`  |
| `skills.curator.pin`               | `operator.admin` |
| `skills.curator.unpin`             | `operator.admin` |
| `skills.curator.restore`           | `operator.admin` |

`skills.proposals.list` includes `installedSkills`, the current Workshop inventory
for the selected agent. Each entry contains `name`, `skillKey`, and `description`.
The separate `proposals` array remains the proposal history and pending queue.

`skills.workshop.read` accepts `name` and optional `agentId`. It returns the
current installed skill's `name`, `skillKey`, `description`, and complete `content`.
An unknown agent or a skill outside that agent's Workshop inventory returns an
error. It never reads a retained proposal as a substitute for a missing skill.

### Workshop inventory and usage

`skills.curator.status` reports live skill usage recorded from trusted
`skill.used` events, retained pre-cron collection review records, and per-workspace
experience review outcomes. Current collection reviews use automation run history.
No skill is archived or expired by age. Every skill reports as `active`.

Clients that advertise the `skill-curator-live-inventory` connection capability
receive `inventory: "live-workshop"`. This view discovers current skills in each
configured agent's Workshop root, including custom agent directories and directly
created skills with no proposal history. Disabled skills and skills filtered from
an agent's prompt remain inventory members. Discovery keeps the existing loader's
file-size, per-source count, and link limits. Invalid skills are excluded; a read
failure is an error, not an empty inventory.

Membership and names come from current files. Usage joins by canonical absolute
file path, not skill name. Renaming metadata at the same path retains usage;
moving a file does not transfer its history. Removed roots, agents, and files do
not return through retained proposals. Applied create proposals supply the
earliest known creation date only. Without that history, `createdAtMs` and
`stateChangedAtMs` are `null`; filesystem dates are not substitutes.

A zero `useCount` or null `lastUsedAtMs` means use is not recorded, not that the
skill was never used. Tracking includes successful known skill reads through
OpenClaw tools registered with the Codex dynamic-tool bridge and explicit
tool-dispatched skill commands. It does not infer native Codex skill activation
or reads made outside the OpenClaw tool boundary. There is no historical backfill.

During upgrades, clients without the capability receive the unchanged legacy
response shape: no marker, numeric creation dates, and only current entries whose
dates are known. Counts describe that returned subset. New clients also accept
older Gateways' unmarked responses. The legacy view has limited coverage and must
not be treated as a complete inventory or used to infer inactivity.

`skills.curator.pin`, `skills.curator.unpin`, and `skills.curator.restore` remain
registered for existing clients, but always return an error explaining that the
weekly collection review manages the skill collection.

### Revision and history methods

`requestRevision` is Gateway-only (no CLI or agent-tool equivalent): it
forwards free-text revision instructions to the owning agent's chat session
instead of replacing `PROPOSAL.md` directly, for UIs that ask the agent to
revise rather than submit literal new content.

`historyStatus` and `historyScan` remain registered for existing clients but
return an error explaining that historical batch scans are retired. They do not
start a run or change skills.

In Workshop, **Learn from past conversations** creates and opens a normal agent
session through `sessions.create`. Its opening message asks the agent to inspect
existing skills, choose useful conversations, and follow the current learning
mode. The chat shows the work and its outcome; there is no separate scan progress
store. See [Self-learning](/tools/self-learning#cost-and-privacy) for model usage
and privacy.

## Storage

```text
<state-dir>/
  state/openclaw.sqlite
  agents/<agentId>/
    agent/workshop-skills/<skill-name>/
      SKILL.md
      assets/
      examples/
      references/
      scripts/
      templates/
  skill-workshop/proposals/<proposal-id>/
    generations/<generation-id>/
      PROPOSAL.md
      assets/
      examples/
      references/
      scripts/
      templates/
```

Unless overridden, `<state-dir>` is `~/.openclaw`.

- `state/openclaw.sqlite`: canonical proposal records and provenance, the active
  generation reference, proposal status, recorded skill usage, collection and
  experience review outcomes, and apply rollback metadata.
- Each generation contains one `PROPOSAL.md` and all of that revision's support
  files. Revision publication never overwrites the active generation in place.
- Generation files are flushed before publication. After the complete bundle is
  renamed into place, OpenClaw syncs the `generations/` parent directory where
  the platform supports directory flushing, before committing SQLite state.
  Platforms that report directory synchronization as unsupported retain atomic
  rename and process-interruption safety, but do not claim power-loss durability
  for that directory entry.
- Support files remain beside their generation's `PROPOSAL.md` so operators can
  review the proposed skill as a normal directory.

Proposals created by older releases can still reference the earlier root-level
`PROPOSAL.md` layout. The stored record identifies that bundle directly; the
next successful revision moves the proposal onto the generation layout and
retires the previous bundle.

Startup and `openclaw doctor --fix` use the same Workshop migration. It imports
the previous `proposals.json`, `proposal.json`, and `rollback.json` metadata into
SQLite after verifying each proposal, then removes the migrated JSON files.
It moves applied legacy Workshop creates into `workshop-skills`, retargets
eligible pending creates, and marks outside updates stale before normal use.
Pending updates follow their relocated skill in the same database commit.
Ownership-only moves preserve the proposal's existing edit time.
Interrupted moves resume without discarding those pending updates.
If older workspace setup files remain, run `openclaw doctor --fix`.
Startup defers the affected skill moves and backup conversion until Doctor
has imported that workspace state.
The migration infers each legacy proposal's owner from its row, origin metadata,
or a unique workspace owner. Ambiguous ownership, or an owner that is no
longer in the agent roster, stays in place and becomes stale.
Legacy collection backups move under the owner agent's backup root together
with their post-cleanup snapshot. A dropped skill remains restorable when its
saved review and create proposal prove its owner, original path, and backup.
Backups without enough ownership evidence remain history-only; their legacy
files stay in place, and restore reports why it cannot use them. Completed
history archives do not block migration of the remaining backups.
If cleanup stops after publishing a restorable backup, the next migration
verifies the saved manifest and all copied files before removing the old copy.
If no configured agent uses a legacy backup's recorded workspace, Doctor checks
its post-cleanup result hashes against every configured agent's Workshop skills.
Exactly one complete match identifies the owner even when the old workspace is
gone. Empty, partial, changed, or ambiguous matches stay preserved; Doctor names
the agents considered and their verification results. Follow the
[manual backup recovery procedure](/tools/skill-workshop/collection-review#when-an-older-backup-cannot-be-restored-automatically)
without changing the current workspace or rewriting the backup manifest.
After a successful repair, restart the Gateway to clear its startup warning.
Skills that were symlinked into a workspace stay where they are as workspace
skills; the migration marks their proposals stale instead of moving them.

Doctor also checks saved automation command arguments, working directories,
condition scripts, and agent messages for literal references to relocated
Workshop skills. It names each affected automation and field during Doctor
repair and on later checks. Retained apply history must establish the original
skill directory; Doctor does not guess it from the current workspace or skill
name when that history is unavailable.

Review each reported field before updating the automation. Doctor offers a
replacement for a complete argument or working-directory path only when the
mapped target exists inside the relocated skill. For paths embedded in scripts
or messages, it reports the directory relocation separately and leaves the
complete target unresolved for manual review. Missing or ambiguous targets also
stay unresolved. Doctor does not rewrite automation content, change schedules,
or run the automation to check it.

If moving the skills empties a workspace, migration retires obsolete
workspace-survival evidence only when saved pre-move facts prove that the same
directory contained only those skills and every moved file is intact.
Missing or replaced workspaces, ordinary project files, and newer workspace
attestations keep their protection.

If a proposal's draft is missing, Suggestions marks it unavailable. You can
reject it, but cannot apply, evaluate, or revise content that is no longer there.
Run `openclaw doctor --fix` to mark these proposals stale and remove them from
actionable Suggestions. Doctor preserves their metadata and remaining files.
If a proposal has unfinished apply recovery, Reject and Quarantine refuse to
dismiss it. Doctor leaves it pending and asks you to restore the draft before
retrying; it does not discard rollback evidence
or change the installed skill.

## Limits

| Limit                           | Value                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Description                     | 160 bytes                                                                    |
| Proposal body                   | `skills.workshop.maxSkillBytes` (default 40,000; hard ceiling 200,000 bytes) |
| Autonomous proposal `SKILL.md`  | 10,000 characters, or strictly shorter when already over the cap             |
| Support files                   | 64 per proposal                                                              |
| Support file size               | 256 KiB each, 2 MiB total                                                    |
| Pending + quarantined proposals | `skills.workshop.maxPending` per agent (default 50)                          |
