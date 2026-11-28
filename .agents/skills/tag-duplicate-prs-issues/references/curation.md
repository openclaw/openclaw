# Duplicate-group curation

## Step 5: Reuse Or Create One prtags Group

Before creating a group, search `prtags` for an existing one.

Start with text search over groups:

```bash
prtags search text -R openclaw/openclaw "<problem phrase>" --types group --limit 10
prtags search similar -R openclaw/openclaw "<problem summary>" --types group --limit 10
prtags group list -R openclaw/openclaw
```

Inspect likely groups:

```bash
prtags group get <group-id>
prtags group get <group-id> --include-metadata
```

Reuse an existing group when:

- it represents the same problem
- it already contains clearly related members
- adding the target would keep the group coherent

Do not widen an existing group just because `gitcrawl` placed several PRs or issues near each other.
Confirm that the actual implementation path and maintainer intent still match before adding the new member.

Create a new group only when no existing group clearly fits.

Create the group with a problem-based title and an intent-based description:

```bash
prtags group create -R openclaw/openclaw \
  --kind mixed \
  --title "<problem-centered title>" \
  --description "<same intent, subsystem, and duplicate-resolution path>" \
  --status open
```

Then attach the target and any known duplicate members:

```bash
prtags group add-pr <group-id> <pr-number>
prtags group add-issue <group-id> <issue-number>
```

If a target appears to already belong to another duplicate group and you cannot safely reuse that group, stop.
Do not create a second group.

## Step 6: Ensure The Annotation Fields Exist

Use `field ensure` so the skill is idempotent.

Recommended target-level fields:

```bash
prtags field ensure -R openclaw/openclaw --name duplicate_status --scope pull_request --type enum --enum-values not_duplicate,candidate,confirmed --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_status --scope issue --type enum --enum-values not_duplicate,candidate,confirmed --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope pull_request --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope issue --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope pull_request --type text --searchable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope issue --type text --searchable
```

Recommended group-level fields:

```bash
prtags field ensure -R openclaw/openclaw --name duplicate_confidence --scope group --type enum --enum-values low,medium,high --filterable
prtags field ensure -R openclaw/openclaw --name duplicate_rationale --scope group --type text --searchable
prtags field ensure -R openclaw/openclaw --name cluster_summary --scope group --type text --searchable
```

## Step 7: Save The Maintainer Judgment In prtags

For a PR:

```bash
prtags annotation pr set -R openclaw/openclaw <pr-number> \
  duplicate_status=confirmed \
  duplicate_confidence=high \
  duplicate_rationale="<same problem, same fix direction, overlapping files and comments>"
```

For an issue:

```bash
prtags annotation issue set -R openclaw/openclaw <issue-number> \
  duplicate_status=confirmed \
  duplicate_confidence=high \
  duplicate_rationale="<same user-visible problem and same intended fix path>"
```

For the group:

```bash
prtags annotation group set <group-id> \
  duplicate_confidence=high \
  cluster_summary="<one-sentence problem summary>" \
  duplicate_rationale="<why these items belong in one duplicate cluster>"
```

When the evidence is incomplete, set `duplicate_status=candidate` and lower the confidence.

If a per-PR or per-issue annotation write fails because `prtags` cannot resolve the target, do not force a fallback write path.
Keep the group state you were able to write, report that the curation backend is still missing the target object, and defer the target-level annotation until `prtags` catches up.

## Step 8: Let prtags Sync The Group Comment

Do not tell the agent to create a GitHub comment directly.
`prtags` owns the outbound GitHub comment as a derived projection of group state.

In the normal case, do not manually trigger comment sync.
When comment sync is configured, group writes already enqueue the derived comment projection automatically.

Use manual sync only as a repair or retry path:

```bash
prtags group sync-comments <group-id>
```

If the maintainer needs to see which groups still need attention, use:

```bash
prtags group list-comment-sync-targets -R openclaw/openclaw
```

The skill should treat the GitHub comment as a consequence of correct `prtags` group state.
It should not treat manual comment authoring as part of the normal duplicate workflow.
It should also not treat `sync-comments` as a required step for every duplicate decision.
