---
summary: "Knowledge scheduled maintenance: zero-model claim relink, schedule configuration, and status"
read_when:
  - You want to change or disable the Knowledge maintenance schedule
  - You are checking why remembered claims are or are not linked to entity pages
  - You are running knowledge_relink on demand
title: "Knowledge maintenance"
sidebarTitle: "Maintenance"
---

Knowledge runs one small scheduled pass. Part of the
[Knowledge plugin](/plugins/knowledge) guide.

The pass currently does one job, **relink**: it links claims that
`knowledge_remember` saved without a subject to the one entity page they name.
Relink never calls a model, never creates pages or stores, and never changes
claim text, evidence, or lifecycle.

## Relink

A claim qualifies when it is active, valid, has no linked entities, and cites a
retained `knowledge_remember` excerpt. Claims are processed in stable ID order:

| Outcome                    | Rule                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `linked` (tier `page`)     | The claim's `source_page` is an active entity page.                                          |
| `linked` (tier `hint`)     | The claim's `subject_hint` names exactly one entity page.                                    |
| `linked` (tier `mention`)  | The claim text names exactly one entity page by ID, title, or alias, with no competing name. |
| `ambiguous` / `no_subject` | Anything else. The claim stays unlinked.                                                     |

A link is an `entities` annotation, published through the normal journal,
receipt, and local Git path. Each link's request ID derives from the claim ID,
revision, and subject, so an interrupted pass replays instead of duplicating. A
link that cannot publish counts as `failed` and is retried on the next pass.

### Run it on demand

`knowledge_relink` runs relink in the caller's authorized partition. It needs
writes enabled.

- `dryRun: true` reports counts and up to 10 examples per outcome without
  publishing. Run it first.
- `limit` (1–500, default 100) bounds how many unlinked claims one call examines.
- Follow `nextCursor` with the same `dryRun` value until it is `null`.
- `include: "all"` (dry run only) lists every current claim with no linked page
  and no source page, whichever tool saved it. Relink links only remembered
  claims; the rest are for review.

## Schedule

The pass is on by default and runs daily at 03:30 in the Gateway host's time
zone. It uses the plugin service scheduler, so it does not appear in OpenClaw
automations. It runs only while `writesEnabled` is `true`.

```json5
{
  plugins: {
    entries: {
      knowledge: {
        config: {
          maintenance: {
            enabled: true,
            schedule: "30 3 * * *",
            timezone: "America/Los_Angeles",
          },
        },
      },
    },
  },
}
```

`schedule` is a five-field cron expression (minute, hour, day, month, weekday).
Schedules use local civil time in the configured zone. A spring-forward change
on a skipped day does not discard matching midnight slots on the following day.
A configured time that does not exist during the forward jump is skipped.
An invalid schedule or time zone does not disable the plugin: the pass is not
scheduled, a warning is logged, and **Settings → Maintenance** shows the error.

Each pass visits every store and every conversation partition in it, in pages of
500 claims. Stores that do not exist yet or are not ready are skipped and never
created. One failing store does not stop the others. A plugin reload or store
reassignment ends the current pass.

The next slot and the last results persist in
`<state dir>/knowledge/registry.sqlite`. If a slot passes while the Gateway is
down, the pass catches up 60 seconds after the next start. Two passes never run
at once.

## Status

**Settings → Maintenance** in the Knowledge page shows the schedule, next run,
last run, and per-store counts. Operators with `operator.read` or higher can read
the same data when `operatorRead` is `true`:

```bash
openclaw gateway call plugins.sessionAction --params '{"pluginId":"knowledge","actionId":"maintenance_status","payload":{}}' --json
```

Each pass logs one summary line, as a warning if any store failed.

Relink adapts the free `page` and `mention` tiers of gbrain's relink. It has no
model tier: a claim that cannot be resolved stays unlinked rather than receiving
an unsupported guess.

## Agent review

Relink leaves claims that name no page, or more than one. Maintenance does not
review them: it runs relink only and never starts an agent turn. An agent
review handles them on its own schedule: an automation whose agent turn follows
the `knowledge-maintenance` skill over every private claim with no linked
page and no source page, whichever tool saved it. It runs weekly by default
(Sundays at 3:45 AM) or, if you choose, nightly at 3:45 AM, after the default
3:30 AM maintenance pass. Each run is an agent turn over every unlinked claim,
so nightly costs more; a run that finds nothing left stops right away. The
retired `maintenance.reviewJobId` setting fails validation; run
`openclaw doctor --fix` to remove it.

The review edits private knowledge, so its automation must run in a session
with the owner's private access. Turn on **Review unlinked claims** from the
[Scribes](/plugins/knowledge/scribes) tab of the Knowledge page. To start it
without the Control UI, open a new conversation in the owner's direct chat and
send the prompt the Scribes tab would send; the
[example prompt](/plugins/knowledge/scribes#example-prompt) shows it. Its
settings are plain bullets, so set your schedule (`45 3 * * 0` weekly or
`45 3 * * *` nightly) and IANA time zone there.

The conversation creates the automation, targets itself, and ends with a
`Scribe status: on — …` line. Each scheduled run receives the automation's run
message, which you can edit on the Automations page. To fix a broken setup,
use **Repair** on the Scribes tab. If the scribe's conversation is reset or
removed, it loses access: start the scribe again from a new conversation.
Conversation partitions are not reviewed.

The `knowledge-maintenance` skill is the agent workflow for the claims relink
leaves unlinked. It chooses subject pages with judgment, creates pages for
substantial missing subjects, retires exact duplicates, supersedes explicitly
replaced claims and status snapshots by their outcome, and folds durable
outcomes into page State. The same skill runs as a claim consolidation review
over other scopes when you ask for one: the claims on one hub or oversized page,
or the claims about one subject since a date. Scribe runs only review the
unlinked residue.
