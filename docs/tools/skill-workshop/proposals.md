---
summary: "Proposal file format, support-file rules, plugin evaluation, and skill_workshop parameters"
title: "Proposal content, support files, and the agent tool"
read_when:
  - You are writing PROPOSAL.md or its support files
  - You are building a plugin evaluator or lifecycle hook
  - You need the skill_workshop action and parameter reference
---

## Plugin evaluation and lifecycle hooks

Gateway plugins can extend Skill Workshop without owning proposal storage or
live skill writes:

- `skill_proposal_evaluate` receives an exact candidate bundle and, for update
  proposals, the complete baseline skill. It returns attributed findings,
  metrics, and an optional `pass`, `revise`, or `block` decision.
- `skill_proposal_changed` observes durable `created`, `revised`,
  `evaluation_completed`, `applied`, `rejected`, `quarantined`, and `stale`
  events.
- `skill_changed` observes committed live skill `created`, `updated`, and
  `removed` events from Workshop and supported install/uninstall paths.

Evaluations are explicit from the CLI, Control UI, Gateway
`skills.proposals.evaluate` method, or agent `skill_workshop` action. Results
are stored on the exact proposal revision and in the append-only proposal event
ledger. Evaluator failures remain attributed results; only a completed
`decision: "block"` prevents apply. Apply also revalidates the evaluated target
tree, so any live skill asset drift requires a fresh evaluation.

The lifecycle supports external optimization loops without embedding one.
Controllers can consume `skills.proposals.events.list`, evaluate an exact
`revisionHash`, revise with `expectedRevisionHash` and `correlationId`, then continue
from the returned event sequence. OpenClaw does not schedule, auto-revise, or
decide when such a loop should stop.

## Proposal content

While pending, the proposal is stored as `PROPOSAL.md` with proposal-only
frontmatter:

```markdown
---
name: "morning-catchup"
description: "Daily inbox catch-up: triage, archive, surface, draft, plan"
status: proposal
version: "v1"
date: "2026-05-30T00:00:00.000Z"
---
```

On apply, Skill Workshop writes the active `SKILL.md` and removes the
proposal-only fields: `status`, proposal `version`, and proposal `date`.

## Support files

Use `--proposal-dir` when the proposed skill needs files beside
`PROPOSAL.md`:

```bash
openclaw skills workshop propose-create \
  --name weekly-update \
  --description "Friday wrap-up: stats, highlights, next week's top three" \
  --proposal-dir ./weekly-update-proposal
```

The directory must contain `PROPOSAL.md`. Support files must live under
`assets/`, `examples/`, `references/`, `scripts/`, or `templates/`. Skill
Workshop scans, hashes, and stores them with the proposal, then writes them
beside the live `SKILL.md` only on apply.

Rejected support-file paths: absolute paths, hidden path segments, path
traversal, overlapping paths, executable files, non-UTF-8 text, null bytes,
and paths outside the standard support folders.

Directory drafts must be completely readable and fit within eight path
components, including the filename. Evaluator bundles require all included target
content to be readable and within sixteen path components. Root `.clawhub`,
`.clawdhub`, and `.openclaw` metadata entries are excluded; those names nested
elsewhere remain included. Unreadable included directories or deeper content
produce an error. Fix the reported directory or reduce its nesting, then retry.
For a collection restore failure, follow the
[manual recovery guidance](/tools/skill-workshop/collection-review#when-an-older-backup-cannot-be-restored-automatically)
instead of restructuring the live tree.

## Agent tool

For personal library operations, `skill_workshop` exposes
`list | read | create | update | share | unshare | transfer | activate | remove | rollback`.
The Gateway chooses the authorized namespace. When Workshop authoring is also
available, `target: "personal"` selects the personal library. Reads return a
stable skill ID and revision. Updates require `skill_id` and `expected_revision`;
omit `proposal_content` to preserve the instructions. Use `files` for named
support-file upserts and `delete_files` for explicit removals. Unmentioned
support files are preserved. Large instructions are returned whole or explicitly
omitted with directions to the operator workflow; binary supporting content is
not injected into model context.

For Workshop proposals, the tool uses one required `action`:
`create | read | prepare_patch | patch | update | revise | list | inspect | evaluate | apply | reject | quarantine | history | restore_collection`.
Other Workshop parameters apply depending on the action:

| Parameter                  | Used by                                                          | Notes                                                                 |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `name`                     | `create`, `inspect`, `revise`                                    | Required for `create`; resolves a pending proposal by name otherwise  |
| `description`              | `create`, `update`, `revise`                                     | Max 160 bytes                                                         |
| `skill_name`               | `read`, `prepare_patch`, `patch`, `update`                       | Existing skill name or key                                            |
| `old_string`               | `prepare_patch`, `patch`                                         | Exact current text; prepare it when the complete skill cannot be read |
| `new_string`               | `patch`                                                          | Replacement for the exact current text                                |
| `proposal_content`         | `create`, `update`, `revise`                                     | Required for create/update; omit on revise to preserve the body       |
| `support_files`            | `create`, `update`, `revise`                                     | Array of `{ path, content }`                                          |
| `goal`, `evidence`         | `create`, `update`, `revise`                                     | Free-text context                                                     |
| `proposal_id`              | `inspect`, `revise`, `evaluate`, `apply`, `reject`, `quarantine` | Target proposal                                                       |
| `artifact_path`            | `inspect`                                                        | `PROPOSAL.md` or one listed support-file path                         |
| `expected_revision_hash`   | `evaluate`, `apply`, `reject`, `quarantine`                      | Rejects a stale orchestration step                                    |
| `correlation_id`           | `evaluate`, `revise`, `apply`, `reject`, `quarantine`            | External run or experiment correlation                                |
| `reason`                   | `apply`, `reject`, `quarantine`                                  | Optional                                                              |
| `query`, `status`, `limit` | `list`                                                           | Filter/paginate; `limit` max 50, default 20                           |

`read` and `prepare_patch` return the resolved `skillName`. Reuse that name as
`skill_name` in follow-up calls; a metadata `skillKey` can match a different
skill's exact name. Update proposals and revisions preserve the existing skill's
frontmatter name.

Only one prepared patch span may be active per skill. A second
`prepare_patch` is rejected until a `patch` attempt consumes or invalidates the
active authorization.

`inspect` returns proposal metadata, a bounded artifact manifest, and one
complete artifact when it fits the selected model's context budget. It selects
`PROPOSAL.md` by default. Set `artifact_path` to read one support file
separately. When the selected artifact does not fit, the result omits its body,
reports the original size, and points to smaller per-artifact reads or the
unbounded operator [CLI command](/tools/skill-workshop/authoring#cli).

Agents must use `skill_workshop` for generated skill work and must not create or
change skill or proposal files directly during foreground authoring. Automatic
background maintenance uses the rooted file-tool path described in
[Self-learning and approval settings](/tools/skill-workshop/configuration) instead.
The foreground rule is advisory and prompt-enforced. A hard guard is not
currently possible at the tool-policy seam.

<Note>
`skill_workshop` is a built-in agent tool and is included in
`tools.profile: "coding"`. If a stricter policy hides it, add
`skill_workshop` to the active `tools.allow` list, or use
`tools.alsoAllow: ["skill_workshop"]` when the scope uses a profile without an
explicit `tools.allow`. Sandboxed runs do not construct the host-side
Workshop proposal tool. When an authorized personal-library capability is
available, sandbox and cloud runs use its Gateway-backed authoring surface
instead; the library and database are not mounted writable into the worker.
Use a normal host-side session or the CLI for Workshop proposal review.
</Note>
