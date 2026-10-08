---
summary: "Common Skill Workshop errors and the tool-policy doctor check"
title: "Skill Workshop troubleshooting"
read_when:
  - A Workshop proposal fails to create, apply, or appear in the list
  - The agent cannot call skill_workshop
---

## Troubleshooting

| Problem                                        | Resolution                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Skill proposal description is too large`      | Shorten `description` to 160 bytes or less.                                                                                                                                                                 |
| `Skill proposal content is too large`          | Shorten the proposal body or raise `skills.workshop.maxSkillBytes`.                                                                                                                                         |
| `Target skill changed after proposal creation` | Revise the proposal against the current target, or create a new proposal.                                                                                                                                   |
| `Proposal scan failed`                         | Inspect scanner findings, then revise or quarantine the proposal.                                                                                                                                           |
| `Support file paths must be under one of...`   | Move support files under `assets/`, `examples/`, `references/`, `scripts/`, or `templates/`.                                                                                                                |
| Proposal does not show in list                 | Check the selected agent and `OPENCLAW_STATE_DIR`.                                                                                                                                                          |
| Agent cannot call `skill_workshop`             | Check the active tool policy and run mode. `coding` includes the tool; restrictive `tools.allow` policies must list it explicitly, and sandboxed runs must use a normal host-side agent session or the CLI. |

### Legacy ownership warnings during an update

Doctor discovers historical workspace setup files from retained Workshop proposals
and collection backups, even when the agent now uses a different workspace. It
imports valid setup history before relocating Workshop records, preserving the
original timestamps and an archived copy without changing workspace configuration.

If an unconfigured historical workspace has missing or unreadable setup state,
Doctor preserves its files and reports a warning. Obsolete proposals become stale;
proposals with unfinished apply recovery and ambiguous collection backups remain
available for manual review. Configured workspace failures and failures after an
import has begun still block repair.

Doctor leaves legacy proposal metadata and collection backups in place when
their workspace has no configured owner or maps to more than one agent. The
warning names the retained path and candidate agents. These ownership warnings
do not stop the other migrations or later Doctor repairs.

Review the retained proposal or backup manifest alongside the configured agent
workspaces. Correct a workspace mapping only when it identifies the actual
owner; do not assign an arbitrary agent or delete the artifacts to clear the
warning. Rerun Doctor after resolving ownership. Outside the historical-workspace
deferrals above, invalid metadata, failed writes, and unfinished recovery remain
migration failures.

A retarget count describes proposals changed during that pass. Any remaining
external targets can belong to different proposals whose migration is blocked.
Review their identifiers, paths, and migration warnings before retrying the same
repair.

Package rollback does not reverse the state-schema migration or relocated skill
files. An older package can therefore be incompatible with the retained state.
See [Schema bumps and older updaters](/reference/database-schemas#schema-bumps-and-older-updaters)
and [Downgrade recovery](/reference/database-schemas#downgrade-recovery).

### Tool-policy diagnostic

In `propose` and `auto` modes, `openclaw doctor` runs the
`core/doctor/skill-workshop-tool-policy` check for each configured agent. Doctor
checks the sandbox construction gate before tool policy: sandboxed runs without
host-granted library-authoring authority do not construct `skill_workshop`, even
when `alsoAllow` lists it. The warning names the effective sandbox setting and
recommends a non-sandboxed session, a human turn with library-authoring authority,
or the `openclaw skills workshop` CLI. For `non-main` mode, this restriction applies
to non-main sessions. Library authority is granted by the host for an authenticated
human turn; it is not an allowlist entry or a permission autonomous reviews can
grant themselves. See [Personal library authoring](/tools/skill-workshop/personal-library).

When the tool can be constructed but policy hides it, the warning names the first
excluding config layer and the exact `allow` or `alsoAllow` change to make. A run
whose explicit allowlist leaves no callable tools also names the sandbox gate
when it excludes the requested Workshop tool. Older runbooks may still use
`openclaw plugins inspect skill-workshop`; that command now explains that Skill
Workshop is built in and prints the same policy hint when applicable.
