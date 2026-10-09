---
summary: "Skills your agent learns on its own: how they are saved, undo, unused-skill cleanup, /learn, config, storage, and operator surfaces"
read_when:
  - You want to know how your agent saves and updates its own skills
  - You want to undo, archive, or restore a learned skill
  - You are turning Skill Workshop learning on or off
title: "Skill Workshop"
sidebarTitle: "Skill Workshop"
---

Skill Workshop holds the skills an agent writes for itself, called **learned
skills**. The agent saves a procedure after hard multi-step work and fixes a
learned skill that misled it; skills nobody uses for 30 days are archived. Every
change applies immediately, saves the previous version first, and can be undone.

Learned skills are procedures, not memory: the method for a task the user
repeats, so the agent does not work it out again each time. Facts about the
user or the world belong in [memory](/concepts/memory). Knowledge about one
codebase, such as its conventions, build commands, or architecture, belongs in
that repository's docs or `AGENTS.md`, where every agent working there reads it,
so the agent does not save it as a learned skill.

Learned skills belong to one agent and are always visible to it: they bypass
`agents.defaults.skills` and `agents.entries.<id>.skills` allowlists. To hide
one, archive it.

Skills you write yourself (workspace, project, managed, ClawHub, plugin, and
bundled skills) are not Workshop skills. Edit them at their source; see
[Creating skills](/tools/creating-skills). For profile-owned skills on a shared
Gateway, see [Personal library authoring](/tools/skill-workshop/personal-library).

## How the agent learns

- **During a turn:** when a learned skill the agent used turns out wrong or
  incomplete, it views the skill and patches the misleading step. After hard
  multi-step work you are likely to repeat, it saves the working procedure,
  patching the skill that covers that kind of task or creating one when none does.
- **Background review:** after enough model work in a conversation, or right
  after a turn that used a learned skill, a background run reviews it and saves
  anything worth keeping. See [Self-learning](/tools/self-learning).
- **`/learn [request]`:** asks the agent to save a skill now, from the current
  conversation or from sources you name. See [`/learn`](#learn).
- **Learn from history:** the Control UI button opens a normal chat
  in which the agent reviews earlier conversations and saves what it finds.
- **Unused-skill cleanup:** learned skills nobody used for 30 days are archived.
  See [Unused-skill cleanup](#unused-skill-cleanup).

Changed skills load in new sessions. A running session keeps the skill snapshot
it started with.

<a id="changes-and-recovery" />

## Undo

When a background run changes a skill, OpenClaw posts one line to the
conversation that triggered it:

```text
💾 Learned: updated `deploy-staging` (tightened the rollback step). Say "undo" to revert this skill change.
```

Reply "undo" and the agent restores the previous version with `skill_workshop`.
Nothing is posted when the review changed nothing. Channel-less Control UI
sessions get the same line as a transcript entry.

You can also undo from the Control UI (**Undo** on the skill's latest change or
in its History tab) or the
CLI:

```bash
openclaw skills workshop restore deploy-staging
openclaw skills workshop restore deploy-staging --version <version-id>
```

Restore saves the current copy before replacing it, so an undo can itself be
undone. A skill that was just created has no earlier version; archive it instead.

<a id="collection-review" />
<a id="weekly-curator" />

## Unused-skill cleanup

When learning is on, OpenClaw archives a learned skill with no activity for 30
days, with the reason `unused for 30 days` and actor `curator` in the change
feed. Activity is the latest of: a recorded read of its `SKILL.md`, a
foreground `skill_workshop` `view`, and its last change (create, patch,
restore). A skill younger than 30 days is never archived. The check runs at
most once a day per agent, after a finished turn, and never delays the turn.
Archive is the normal versioned archive: restore it any time.

Cleanup only runs for agents whose default runtime is the embedded OpenClaw
harness, in the Gateway process. The Codex app-server harness reads skills with
its native shell, which OpenClaw cannot attribute to a skill, so cleanup stays
off for Codex agents rather than archiving skills that are in use.

Earlier versions ran a weekly curator automation
(`skill-collection-review:<agentId>`). It is retired: the Gateway deletes those
cron rows on upgrade and creates no replacement.

<a id="learn" />

## `/learn`

```text
/learn
/learn docs/runbook.md; focus on recovery
```

`/learn` is a normal foreground turn. With no request, the agent saves the
reusable workflow from the current conversation. With a request, it gathers the
named paths, URLs, notes, or conversation references with its normal tools and
honors any focus, scope, or naming you give. It views related skills first,
patches the one that covers the task, and creates a new skill only when none
does. Related skills that cover the same class of task get merged into one
umbrella skill: it patches the survivor and archives the rest with
`absorbed_into`. Then it tells you which skill changed. If there is nothing
durable to learn, it changes nothing.

`/learn` works in both learning modes. It replies with an explanation instead
when `skill_workshop` is unavailable, for example in a sandboxed session or
when tool policy hides the tool.

## Agent tool

The built-in `skill_workshop` tool is how every learned-skill change is made.
It is part of `tools.profile: "coding"`; with a stricter policy, add it to
`tools.allow` or `tools.alsoAllow`.

| Action        | Parameters                                           | Effect                                                                   |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `list`        | —                                                    | Lists live skills and archived skills                                    |
| `view`        | `name`, optional `file_path`, `version`              | Reads a file, current or from a saved version                            |
| `create`      | `name`, `content` (full `SKILL.md`)                  | Creates a new skill                                                      |
| `patch`       | `name`, `old_text`, `new_text`, optional `file_path` | Replaces one exact, unique span                                          |
| `write_file`  | `name`, `file_path`, `content`                       | Writes a support file, or rewrites `SKILL.md`                            |
| `remove_file` | `name`, `file_path`                                  | Deletes one support file; `SKILL.md` goes only through `archive`         |
| `archive`     | `name`, optional `absorbed_into`, `reason`           | Hides the skill; `absorbed_into` names the live skill that now covers it |
| `restore`     | `name`, optional `version`                           | Restores the newest saved version, or the one named                      |

Every mutating action accepts `reason`, one short line that appears in the
change feed and the chat notice. Every change saves the previous version first.

Writes are validated before they land:

- Names use 1-63 lowercase letters, digits, or hyphens and start with a letter
  or digit.
- `SKILL.md` needs frontmatter whose `name` matches the skill directory and a
  `description` of 1-1024 bytes (aim for about 160). It must fit within `skills.workshop.maxSkillBytes`.
- Support files go under `references/`, `templates/`, `scripts/`, or `assets/`,
  up to 256 KiB each. Absolute paths, traversal, and symlinks are refused.
- A critical security-scanner finding, including a literal secret, refuses the
  write and names the file, line, and rule.

The background review must `view` an existing skill before it can `patch`,
`write_file`, `remove_file`, or `archive` it, and its archives need
`absorbed_into` or `reason`. A foreground `view` counts as using the skill.

A successful `create`, `patch`, or `write_file` of `SKILL.md` may end with up to
three `Advisory (not blocking)` lines: authoring issues the write introduced (a
description over 160 bytes or opening with "This skill", a body over 250 lines
or 12 KB, emphasis words, three or more Never/Don't steps, update notes or
dates). The write has already landed. A `create` also lists the agent's other
learned skills, so the agent itself decides whether the new skill duplicates
one and should be merged.

## Configuration

```json5
{
  skills: {
    workshop: {
      autonomous: { mode: "auto" },
      maxSkillBytes: 40000,
    },
  },
}
```

| Setting                           | Default  | Effect                                                                                  |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `skills.workshop.autonomous.mode` | `"auto"` | `"auto"` enables the background review and unused-skill cleanup. `"off"` disables both. |
| `skills.workshop.maxSkillBytes`   | `40000`  | Maximum `SKILL.md` size in bytes (1024-200000).                                         |

```bash
openclaw config set skills.workshop.autonomous.mode off
openclaw config set skills.workshop.autonomous.mode auto
```

With `off`, the agent can still create and update learned skills when you ask,
through `/learn`, or in a **Learn from past conversations** session. See
[Skills config](/tools/skills-config#workshop-skills-workshop) for the schema.

## Where files live

```text
<agentDir>/workshop-skills/
  <name>/
    SKILL.md
    references/  templates/  scripts/  assets/
  .archive/
    <name>/<versionId>/     # full copy of the skill before each change
```

`<agentDir>` defaults to `<state-dir>/agents/<agentId>/agent`, or
`agents.entries.<id>.agentDir` when set. `<state-dir>` is `~/.openclaw` unless
`OPENCLAW_STATE_DIR` overrides it.

A version is saved before every change, including archive and restore. The
newest 10 versions per skill are kept. An archived skill has no live directory;
its newest version restores it. The change feed (who changed which skill, when,
and why) lives in the state database and keeps the newest 500 entries per agent.

## Operator surfaces

- **Control UI:** open **Plugins → Skill workshop**. Learned skills are listed
  most used first (or by recent activity or name), each with its latest change
  and **Undo**; skills idle for two weeks are flagged, since
  [unused-skill cleanup](#unused-skill-cleanup) may archive them at 30 days.
  Selecting a skill shows its instructions, support files, and history.
  From the history you can compare an earlier version with today's, restore it,
  or undo a change. **Archive** and **Restore** switch a skill between the
  Active and Archived lists. The page header holds the learning mode switch and
  **Learn from history**.
- **CLI:** `openclaw skills workshop list | changes | show | archive | restore`.
  See [Skills CLI](/cli/skills#skill-workshop).
- **Plugins:** the [`skill_changed`](/plugins/hooks/reference#skill-lifecycle)
  hook observes each committed Workshop change.

Gateway methods take an optional `agentId` (default agent when omitted):

| Method                    | Scope            | Params                          | Returns                                                                                         |
| ------------------------- | ---------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `skills.workshop.list`    | `operator.read`  | —                               | `agentId`, `mode`, `root`, live `skills` (with `useCount`, `lastUsedAtMs`), `archived` versions |
| `skills.workshop.changes` | `operator.read`  | `limit` (up to 500), `beforeMs` | `changes`, newest first                                                                         |
| `skills.workshop.read`    | `operator.read`  | `name`, `filePath`, `versionId` | `name`, `filePath`, `content`, `files`                                                          |
| `skills.workshop.archive` | `operator.admin` | `name`, `reason`                | `change`                                                                                        |
| `skills.workshop.restore` | `operator.admin` | `name`, `versionId`             | `change`                                                                                        |

Archive and restore from the CLI, Control UI, or Gateway are recorded as `user`
changes.

<a id="when-an-older-backup-cannot-be-restored-automatically" />

## Upgrading from earlier releases

Earlier releases staged learned skills as drafts for review. `openclaw doctor
--fix` exports any pending drafts and removes the old settings; see
[State migrations](/cli/doctor/state-migrations) and
[Skills config](/tools/skills-config#workshop-skills-workshop). Exported drafts
are not loaded. Ask the agent to save one with `/learn` if you still want it.

The earlier `skills.proposals.*` and `skills.curator.*` Gateway methods stay
registered but return an error that points to the methods above. The
`skill_proposal_evaluate` and `skill_proposal_changed` plugin hooks were removed;
see [Removed surfaces](/plugins/sdk-migration/removed-surfaces#skill-workshop-proposal-hooks).

Backups written by the earlier weekly review under
`<agentDir>/skill-workshop/collection-backups/` are no longer read. Copy any
files you need from them by hand; OpenClaw does not restore them.

## Troubleshooting

| Problem                            | Check                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nothing is ever learned            | `skills.workshop.autonomous.mode` is `auto`, the conversation is eligible, and tool policy allows `skill_workshop`. See [Self-learning](/tools/self-learning#troubleshooting). |
| Agent cannot call `skill_workshop` | Sandboxed runs do not get the tool. Use a non-sandboxed session or the CLI. Otherwise add the tool to `tools.allow` or `tools.alsoAllow`.                                      |
| A write is refused                 | The error names the fix: rename the skill, correct the frontmatter, shorten the description or `SKILL.md`, or remove the flagged line.                                         |
| An unwanted change was made        | Say "undo", press **Undo** in the Control UI, or run `openclaw skills workshop restore <name>`.                                                                                |
| A skill was archived unexpectedly  | Unused-skill cleanup archives skills with no activity for 30 days. Run `openclaw skills workshop restore <name>`.                                                              |

In `auto` mode, `openclaw doctor` runs the `core/doctor/skill-workshop-tool-policy`
check for each agent. It names the sandbox setting or the config layer that
hides `skill_workshop` and the exact `allow` or `alsoAllow` change to make.

## Related

- [Self-learning](/tools/self-learning) for the background review
- [Skills](/tools/skills) for load order and visibility
- [Creating skills](/tools/creating-skills) for hand-written `SKILL.md`
- [Skills config](/tools/skills-config#workshop-skills-workshop) for the `skills.workshop` schema
- [Skills CLI](/cli/skills#skill-workshop) for `openclaw skills workshop`
