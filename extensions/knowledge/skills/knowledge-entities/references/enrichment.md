# Enrichment

Scale effort to importance. Stop when the entity's tier has enough signal.

## When to enrich

Enrich when an entity appears in a source being ingested, the user mentions it,
or it has a material new event. Don't enrich random mentions with no relationship
signal, bots or spam, entities with no connection to the user's work, or a page
enriched in the past week without new signal.

## During ingestion

When another skill (meeting, document) sends you here, the source is the
enrichment. Use Knowledge and the source itself, plus two kinds of web lookup:

- **Participant identity:** when participants appear by first name only, fetch
  the organization's public team or people page once (from the roster's email
  domain or the project's site) and match names against it. Record the match and
  its basis; a single unambiguous match is enough for a full name.
- **Spelling:** a targeted query to confirm a proper noun's canonical spelling.

Keep only the passage that settles the question. Skip background reading about
products, standards or companies (homepages, docs). Full tier research below is
for an explicit enrichment request.

## Tiers

| Tier    | Who                                                 | Effort                                                                                 |
| ------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Key     | Close collaborators, key contacts                   | All relevant Knowledge context; task-scoped web research; enrichment APIs if available |
| Notable | Occasional interactions, relevant industry entities | Knowledge cross-reference plus targeted web research if needed                         |
| Minor   | Worth tracking, limited relevance                   | Source and Knowledge cross-reference only                                              |

An actual meeting participant gets a page even when thin; their participation and
contribution are the content.

## What to extract

Capture texture, not just facts:

| Signal                                    | Goes to                              |
| ----------------------------------------- | ------------------------------------ |
| Role, company, location, hard facts       | State (and declared ontology fields) |
| Opinions, beliefs, positions              | What They Believe                    |
| Current projects, things shipped          | What They're Building                |
| Ambition, career arc                      | What Motivates Them                  |
| Topics they keep returning to             | Hobby Horses                         |
| How they communicate (observed)           | Communication Style                  |
| Who they work with, amplify or argue with | Network, relationships               |
| Ascending, pivoting, plateauing           | Trajectory                           |
| Pending items                             | Open Threads                         |

In conversations, read the reply chain before assigning a position: separate
suggestions, questions, reported results and agreed decisions. Don't infer
motives from sparse context.

## Lookups, in order

1. **Knowledge (always):** the resolve chain in [identity](identity.md), plus
   related pages (the company page when enriching a person, and the reverse).
2. **Web research (Key and Notable):** send what Knowledge already says as
   context and ask for what's new, so results are a delta, not a rehash.
3. **Social profiles (any tier, only when a handle is known):** best signal for
   what someone currently thinks.
4. **People/company enrichment APIs (Key, only if available):** career history,
   funding, headcount. Never buy access or treat a missing API as a blocker.

Retain each response you rely on with its source and fetch date
([sources](sources.md)).

## Validation

- Name or identity mismatch between Knowledge and an external result: don't
  update the page; flag it.
- Obviously wrong, joke or stale data: retain it if useful, don't write it into
  the page.
- When in doubt, retain the raw result and leave the page unchanged.
- Rate limit or auth failure: back off or stop and report which access is
  missing. Never fill the gap with guesses.

## Bulk runs

Enrich 3–5 entities first and read the results before scaling. Batch the rest,
respect rate limits, and report: entities processed, created versus updated,
sources used, contradictions and failures.
