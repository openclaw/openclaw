---
summary: "Workshop proposal rules, Control UI review, and the proposal state diagram"
title: "How Skill Workshop works"
read_when:
  - You want the proposal rules before applying a generated skill
  - You are reviewing installed skills or suggestions in the Control UI
  - You need the proposal state transitions
---

## How it works

The following lifecycle applies to Workshop proposals:

- **Proposal first:** generated content is stored as `PROPOSAL.md`, not
  `SKILL.md`.
- **Apply is the only live write:** create, update, and revise never change
  active skills.
- **Directory-owned updates:** creates and updates stay inside
  `<state-dir>/agents/<agentId>/agent/workshop-skills`. A skill is Workshop-owned
  exactly when it is contained in that agent's directory.
- **No clobber:** create fails if the target already exists in that agent's
  Workshop directory. Skills from other sources are never changed.
  For same-named skills, [loading order](/tools/skills#loading-order) determines
  which definition is used.
- **Hash bound:** update proposals bind to the current target hash and go
  `stale` if the live skill changes before apply.
- **Scanner gated:** apply reruns the security scanner before writing. Only
  critical findings block apply; warn-level findings remain visible but do not
  block it.
- **Recoverable:** apply writes rollback metadata before touching live files.
- **Revision atomic:** create and revise flush a complete immutable proposal
  generation, publish it with an atomic rename, then sync its parent directory
  where supported before publishing the SQLite record and event together.
  Process interruption exposes either the complete previous generation or the
  complete new one.
- **Consistent surfaces:** chat, CLI, and Gateway all call the same service.

## Review in the Control UI

Open **Plugins → Workshop** and select the agent whose skills you want to inspect.

- **Skills** opens by default and lists the skills currently installed in that
  agent's Workshop directory. Skills with instruction changes appear first.
  Select one to read its complete current instructions. Changed skills show
  additions and removals inline with all unchanged sections in one scrollable
  comparison. Unchanged skills show their current instructions as Markdown.
  Current instructions remain readable while saved versions are compared.
- **Suggestions** contains pending proposals that you can evaluate, revise,
  apply, or reject.

Past applied, rejected, quarantined, and stale proposals remain available through
CLI and Gateway inspection. They are not listed as a separate Control UI section
or counted as installed skills.

Comparisons use retained applied versions, not a complete edit timeline.
Relative dates identify the saved baseline, not when later edits occurred.
Supporting files and frontmatter are not compared. Missing versions are labeled;
the complete current instructions remain readable without a saved version.
No historical content is reconstructed.

Removing an installed skill does not remove its proposal history. Reading a
historical draft does not restore or reinstall it. Handwritten and externally
installed skills remain on their owning skills surfaces.

## Lifecycle

```text
create/update -> pending
revise        -> pending
evaluate      -> pending
apply         -> applied
reject        -> rejected
quarantine    -> quarantined
target change -> stale
```

Only a `pending` proposal can be revised, applied, rejected, or quarantined.
