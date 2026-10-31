---
summary: "Skills your agent learns on its own: how they are saved, undo, unused-skill cleanup, skill diet, /learn, config, storage, and operator surfaces"
read_when:
  - You want to know how your agent saves and updates its own skills
  - You want to undo, archive, or restore a learned skill
  - You are turning Skill Workshop learning on or off
  - You want to review learned changes before they apply
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

Skill Workshop ships as the bundled `skill-workshop` plugin, enabled by default.
Disabling it (`plugins.entries.skill-workshop.enabled: false`, or
`plugins.enabled: false`) stops loading learned skills into the agent's prompt.

Skills you write yourself (workspace, project, managed, ClawHub, plugin, and
bundled skills) are not Workshop skills. Edit them at their source; see
[Creating skills](/tools/creating-skills). For profile-owned skills on a shared
Gateway, see [Personal library authoring](/tools/skill-workshop/personal-library).

## How the agent learns

- **During a turn:** when a learned skill the agent used turns out wrong or
  incomplete, it views the skill and patches the misleading step. After hard
  multi-step work you are likely to repeat, it saves the working procedure,
  patching the skill that covers that kind of task or creating one when none does.
- **Background review:** after 10 accumulated model iterations in a conversation,
  a background run reviews it and saves anything worth keeping. In `propose`
  mode it saves a [draft](#drafts) for you to review instead.
  See [Self-learning](/tools/self-learning).
- **`/learn [request]`:** asks the agent to learn now, from the current
  conversation or from sources you name. Procedures become skills; facts and
  preferences go to memory when the memory plugin supports it. See [`/learn`](#learn).
- **Learn from history:** the Control UI button opens a normal chat
  in which the agent reviews earlier conversations and saves what it finds.
- **Unused-skill cleanup:** learned skills nobody used for 30 days are archived.
  See [Unused-skill cleanup](#unused-skill-cleanup).
- **Skill diet:** once a day, one oversized learned skill is shrunk without
  changing its rules. See [Skill diet](#skill-diet).

Changed skills load in new sessions. A running session keeps the skill snapshot
it started with.

<a id="changes-and-recovery" />

## Undo

When a background run changes a skill, the Control UI chat shows a compact
**Learned** row; each skill name opens that skill in the Workshop. Channel
messages are off by default. Set `skills.workshop.autonomous.channelNotices:
true` to post the notice to the conversation that triggered the review
instead; that session's Control UI chat then shows it as plain text:

```text
💾 Learned: updated `deploy-staging` (tightened the rollback step). Say "undo" to revert this skill change.
```

Say "undo" in the conversation and the agent restores the previous version
with `skill_workshop`, whether channel notices are on or off. Nothing appears
when the review changed nothing. Slack never gets a channel message; its
sessions still get the Control UI row.

To revert everything one review changed without asking the agent:

- Press **Undo** on the notice. Channels with buttons render it under the
  line; plain-text channels show the command to copy instead.
- Press **Undo** on the Control UI **Learned** row.
- Send `/learn undo <id>`, where `<id>` is the review id in the channel
  notice's command.

Each restores the version saved before the review's first change of a skill
and archives skills the review created. Pressing it again reports that the
change was already undone. The chat command needs the owner, plus
`operator.admin` from Gateway clients.

You can also undo one skill from the Control UI (**Undo** on the skill's latest
change or in its History tab) or the CLI:

```bash
openclaw skills workshop restore deploy-staging
openclaw skills workshop restore deploy-staging --version <version-id>
```

Restore saves the current copy before replacing it, so an undo can itself be
undone. A skill that was just created has no earlier version; archive it instead.

## Drafts

Set `skills.workshop.autonomous.mode` to `"propose"` to review background
learning before it applies. Background reviews then change no skills. A review
that finds a lesson saves a draft: the complete proposed `SKILL.md` for the skill
it would create or replace, with its reason. Drafts are not announced and never
load as skills.

Review drafts in either place:

- **Control UI:** the **Drafts** list on **Plugins → Skill workshop** shows each
  draft with its reason. A draft for a live skill opens as a diff against it; a
  new skill opens as its instructions. **Apply** saves the draft through the
  normal versioned write, so the previous version is kept and **Undo** works.
  **Discard** deletes the draft and changes no skill.
- **Chat:** `/learn drafts` has the agent read every waiting draft and the live
  skills they would change, and judge them together. It proposes which changes
  to keep, merging related drafts, and asks before saving anything. It saves
  only what you approve, discards what you approve or reject, and leaves the
  rest for later. `/learn drafts <skill>` reviews only the drafts for that skill.
  Text after the command is your focus, for example
  `/learn drafts deploy-staging keep only the rollback step`.

Up to 50 drafts wait per agent. While 50 are waiting, reviews save nothing new.
Unused-skill cleanup and the skill diet run only in `auto` mode.

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

## Skill diet

Learned skills grow as lessons are added, and every run that uses a skill reads
its whole `SKILL.md`. In `auto` mode, the daily pass that runs unused-skill
cleanup also diets one oversized learned skill per agent:

1. **Pick.** A skill qualifies when its `SKILL.md` body is over 12 KB and it
   has not changed for a day. Qualifying skills are taken in turn by name, one
   per day.
2. **Rewrite.** The agent's primary model moves whole `##` sections that only
   some runs need into new files under `references/` and ends `SKILL.md`
   with a `## Look up the case` index. It tightens the remaining text and adds
   no rules.
3. **Check.** OpenClaw copies the moved sections verbatim, re-pointing their
   relative links, and requires every link and heading anchor to resolve, every
   new reference to be linked from `SKILL.md`, `SKILL.md` to shrink by at least
   20%, and every file to pass normal Workshop validation. Skills that use
   titled or reference-style Markdown links are not split.
4. **Review.** A separate model call compares the original `SKILL.md` with the
   rewrite rule by rule. It reports rules that were dropped or weakened, rules
   that moved to a reference the agent would not read when they apply, and
   added rules. Findings go back for one repair. If the second review still
   reports any, the skill is left unchanged.
5. **Publish.** The result is one versioned change by actor `curator`, with a
   summary such as `diet: SKILL.md 20.1 → 7.8 KB; moved 8 section(s) to …`. If
   the skill changed while the diet ran, nothing is written.

To undo a diet, restore the previous version from the skill's history in the
Control UI or with `openclaw skills workshop restore <name>`. Restoring also
removes the reference files the diet added. A skill that cannot be dieted, for
example one long procedure section, is left unchanged and tried again when its
turn comes around. A diet makes two to four tool-free model calls on the
agent's primary model and sends the skill's text to that provider.

<a id="learn" />

## `/learn`

```text
/learn
/learn docs/runbook.md; focus on recovery
/learn drafts
/learn drafts deploy-staging keep only the rollback step
```

`/learn` is a normal foreground turn. With no request, the agent saves the
reusable workflow from the current conversation. With a request, it gathers the
named paths, URLs, notes, or conversation references with its normal tools and
honors any focus, scope, or naming you give. It views related skills first,
patches the one that covers the task, and creates a new skill only when none
does. Related skills that cover the same class of task get merged into one
umbrella skill: it patches the survivor and archives the rest with
`absorbed_into`. Then it tells you which skill changed. If there is nothing
durable to learn, it changes nothing. `/learn drafts [skill] [focus]` reviews
the waiting [drafts](#drafts) and asks before saving.

When the selected memory plugin supports learning (see
[provider-neutral memory runtime](/plugins/sdk-overview/memory-and-context#provider-neutral-memory-runtime)),
`/learn` covers both media: procedures for a
repeatable class of task go to learned skills, and facts, preferences,
decisions, and knowledge about one codebase or person go to memory, following
the memory plugin's guidance. With `skill_workshop` hidden, `/learn` learns into
memory alone.

`/learn` works in every learning mode. It replies with an explanation instead
when neither `skill_workshop` nor the memory plugin's learning tools are
available, for example in a sandboxed session or when tool policy hides them.

`/learn undo <id>` is the one exception: with a review id, it reverts that
background review without a model turn. See [Undo](#undo). Any other text after
`/learn` is a request.

## Agent tool

The built-in `skill_workshop` tool is how every learned-skill change is made.
It is part of `tools.profile: "coding"`; with a stricter policy, add it to
`tools.allow` or `tools.alsoAllow`.

| Action        | Parameters                                           | Effect                                                                   |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `list`        | —                                                    | Lists live skills, archived skills, and waiting drafts                   |
| `view`        | `name`, optional `file_path`, `version`              | Reads a file, current or from a saved version                            |
| `create`      | `name`, `content` (full `SKILL.md`)                  | Creates a new skill                                                      |
| `patch`       | `name`, `old_text`, `new_text`, optional `file_path` | Replaces one exact, unique span                                          |
| `write_file`  | `name`, `file_path`, `content`                       | Writes a support file, or rewrites `SKILL.md`                            |
| `remove_file` | `name`, `file_path`                                  | Deletes one support file; `SKILL.md` goes only through `archive`         |
| `archive`     | `name`, optional `absorbed_into`, `reason`           | Hides the skill; `absorbed_into` names the live skill that now covers it |
| `restore`     | `name`, optional `version`                           | Restores the newest saved version, or the one named                      |
| `draft`       | `name`, `content` (full `SKILL.md`)                  | Saves a [draft](#drafts) for review; changes no skill                    |
| `view`        | `draft`, optional `file_path`                        | Reads a waiting draft                                                    |
| `discard`     | `draft`                                              | Deletes a reviewed draft; background reviews cannot discard              |

Every mutating action accepts `reason`, one short line that appears in the
change feed and the chat notice. Every change saves the previous version first.

Writes are validated before they land:

- New names use 1-63 lowercase letters, digits, or hyphens and start with a letter
  or digit. Longer names saved by earlier releases stay listed and manageable.
- `SKILL.md` needs frontmatter whose `name` matches the skill directory and a
  `description` of 1-1024 bytes (aim for about 160). It must fit within `skills.workshop.maxSkillBytes`.
- Support files go under `references/`, `templates/`, `scripts/`, or `assets/`,
  up to 256 KiB each. Absolute paths, traversal, and symlinks are refused.
- A critical security-scanner finding, including a literal secret, refuses the
  write and names the file, line, and rule.

The background review must `view` an existing skill before it can `patch`,
`write_file`, `remove_file`, or `archive` it, and its archives need
`absorbed_into` or `reason`. In `propose` mode it can only `list`, `view`, and
`draft`. A foreground `view` counts as using the skill.

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

| Setting                                     | Default  | Effect                                                                                                                                                                            |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills.workshop.autonomous.mode`           | `"auto"` | `"auto"` enables the background review, unused-skill cleanup, and the [skill diet](#skill-diet). `"propose"` makes the review save [drafts](#drafts). `"off"` disables all three. |
| `skills.workshop.autonomous.channelNotices` | `false`  | Also post background review notices to channel conversations, except Slack.                                                                                                       |
| `skills.workshop.maxSkillBytes`             | `40000`  | Maximum `SKILL.md` size in bytes (1024-200000).                                                                                                                                   |

```bash
openclaw config set skills.workshop.autonomous.mode off
openclaw config set skills.workshop.autonomous.mode propose
openclaw config set skills.workshop.autonomous.mode auto
```

With `off` or `propose`, the agent can still create and update learned skills when you ask,
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
  .drafts/
    <draftId>/SKILL.md      # proposed skill waiting for /learn drafts
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
  Active and Archived lists. The **Drafts** list appears in `propose` mode or
  while drafts wait; see [Drafts](#drafts). The page header holds the learning mode switch and
  **Learn from history**. If the learning configuration cannot be loaded, the
  page shows the error and a **Retry** button while keeping the skill library available.
- **CLI:** `openclaw skills workshop list | changes | show | archive | restore`.
  See [Skills CLI](/cli/skills#skill-workshop).
- **Plugins:** the [`skill_changed`](/plugins/hooks/reference#skill-lifecycle)
  hook observes each committed Workshop change.

Gateway methods take an optional `agentId` (default agent when omitted):

| Method                         | Scope            | Params                                     | Returns                                                                                                                                                         |
| ------------------------------ | ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills.workshop.list`         | `operator.read`  | —                                          | `agentId`, `mode`, `root`, live `skills` (with `useCount`, `lastUsedAtMs`), `archived` versions, waiting `drafts` (`id`, `skillName`, `summary`, `createdAtMs`) |
| `skills.workshop.changes`      | `operator.read`  | `limit` (up to 500), `beforeMs`            | `changes`, newest first                                                                                                                                         |
| `skills.workshop.read`         | `operator.read`  | `name`, `filePath`, `versionId`, `draftId` | `name`, `filePath`, `content`, `files`                                                                                                                          |
| `skills.workshop.archive`      | `operator.admin` | `name`, `reason`                           | `change`                                                                                                                                                        |
| `skills.workshop.restore`      | `operator.admin` | `name`, `versionId`                        | `change`                                                                                                                                                        |
| `skills.workshop.undo`         | `operator.admin` | `runId` (a review's run id)                | `status` (`undone` or `already-undone`), `changes` made by this call                                                                                            |
| `skills.workshop.applyDraft`   | `operator.admin` | `name`, `draftId`                          | `changes` made by saving the draft; the draft is deleted                                                                                                        |
| `skills.workshop.discardDraft` | `operator.admin` | `name`, `draftId`                          | `changes` (always empty); the draft is deleted                                                                                                                  |

Archive, restore, undo, and applied drafts from the CLI, Control UI, chat, or Gateway are
recorded as `user` changes.

<a id="when-an-older-backup-cannot-be-restored-automatically" />

## Upgrading from earlier releases

Earlier releases staged learned skills as proposals for review. `openclaw doctor
--fix` exports any pending proposals to the [drafts](#drafts) directory and
removes the old settings; see [State migrations](/cli/doctor/state-migrations)
and [Skills config](/tools/skills-config#workshop-skills-workshop). Review them
with `/learn drafts`. Proposals that an earlier Doctor exported to
`.archive/.retired-proposals/` move to `.drafts/` on the next Doctor run.

The earlier `skills.proposals.*` and `skills.curator.*` Gateway methods stay
registered but return an error that points to the methods above. The
`skill_proposal_evaluate` and `skill_proposal_changed` plugin hooks were removed;
see [Removed surfaces](/plugins/sdk-migration/removed-surfaces#skill-workshop-proposal-hooks).

Backups written by the earlier weekly review under
`<agentDir>/skill-workshop/collection-backups/` are no longer read. Copy any
files you need from them by hand; OpenClaw does not restore them.

## Troubleshooting

| Problem                            | Check                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing is ever learned            | `skills.workshop.autonomous.mode` is `auto` (or `propose`, then check `/learn drafts`), the conversation is eligible, and tool policy allows `skill_workshop`. See [Self-learning](/tools/self-learning#troubleshooting). |
| Agent cannot call `skill_workshop` | Sandboxed runs do not get the tool. Use a non-sandboxed session or the CLI. Otherwise add the tool to `tools.allow` or `tools.alsoAllow`.                                                                                 |
| A write is refused                 | The error names the fix: rename the skill, correct the frontmatter, shorten the description or `SKILL.md`, or remove the flagged line.                                                                                    |
| An unwanted change was made        | Press **Undo** on the notice, say "undo", send `/learn undo <id>`, or run `openclaw skills workshop restore <name>`.                                                                                                      |
| A skill was archived unexpectedly  | Unused-skill cleanup archives skills with no activity for 30 days. Run `openclaw skills workshop restore <name>`.                                                                                                         |
| A skill was split into references  | The daily [skill diet](#skill-diet) shrank it. Run `openclaw skills workshop restore <name>` to undo.                                                                                                                     |

In `auto` and `propose` modes, `openclaw doctor` runs the `core/doctor/skill-workshop-tool-policy`
check for each agent. It names the sandbox setting or the config layer that
hides `skill_workshop` and the exact `allow` or `alsoAllow` change to make.

## Related

- [Self-learning](/tools/self-learning) for the background review
- [Skills](/tools/skills) for load order and visibility
- [Creating skills](/tools/creating-skills) for hand-written `SKILL.md`
- [Skills config](/tools/skills-config#workshop-skills-workshop) for the `skills.workshop` schema
- [Skills CLI](/cli/skills#skill-workshop) for `openclaw skills workshop`
