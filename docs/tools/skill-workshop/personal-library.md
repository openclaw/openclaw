---
summary: "Create and update profile-owned personal skills on a shared Gateway"
title: "Personal library authoring"
read_when:
  - You are creating or updating a personal-library skill on a shared Gateway
  - You need the personal create, update, read, and file-preservation rules
  - You want to know why a personal publication was refused
---

## Personal library authoring

On a shared Gateway, ask the agent normally: **Create a skill for me that
summarizes a reviewed change list.** The authenticated requester owns the
result, even when another person created or owns the session. No separate
authoring mode or identity argument is required. A single administrator keeps
the Workshop workflow by default; explicitly ask for a personal-library skill
when that is the intended destination.

Personal create and update operations publish complete managed revisions after
validation and scanning. The response identifies the skill and revision and
explains when it becomes available. Publication does not replace the current
session's selection: ask to attach or refresh it explicitly for the next turn.
Read before updating: the response includes the human-facing `slug`, generated
command `name`, revision, and personal edit permission. The update parameter
`name` means the slug, not the command name. Omit `name` or `proposal_content`
on update to preserve them.

For personal model operations, `files` contains named support-file upserts;
omitting it or passing `[]` preserves all other files. Omitted executable flags
are preserved too. Use `delete_files` to intentionally remove exact supporting
paths. Duplicate or conflicting edits and removal of `SKILL.md` are rejected;
change its full body with `proposal_content`. Operator `skills.library.save`
continues to replace the complete bundle.

Use `read` with `artifact_path` to read one whole UTF-8 support file, defaulting
to `SKILL.md`. Binary or oversized artifacts produce a visible omission and
direct you to My skills or the CLI; they are never returned as partial
instructions or a base64 dump. Personal authoring has no pending-draft action:
unsolicited improvements are suggestions, not publications.

Personal mutations require a current, authenticated human turn. Autonomous
reviews, cron jobs, and child runs do not acquire fresh personal authoring
permission. If a different person steers an active authoring turn, send a fresh
attributed message before publishing. Sharing makes a skill usable by the team;
only an administrator can transfer its management ownership to the team.
