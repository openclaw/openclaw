# Notion Postmortem Index

Use this file to route into first-party incident writeups stored in Notion
without committing direct workspace URLs into the repo.

## Database

- Internal incident postmortems live in the shared Notion database commonly
  referred to as `Post Mortems`.

## How To Find A Specific Postmortem

- open the Morpho Notion workspace
- navigate to the shared `Post Mortems` database from the engineering resources
  area or internal wiki
- API path:
  - search candidate pages by title:
    - `/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh search --query "post mortem" --filter page`
  - fetch a page directly as enhanced markdown:
    - `/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh page markdown <page-id-or-url>`
  - if you know the table/data source id already:
    - `/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh data-source query <data-source-id-or-url> --body-file /tmp/notion-query.json`
- search by:
  - service or component name
  - incident date or time window
  - related ticket or incident identifier
  - known symptom pattern

## What This Index Covers

- API/service outages
- stale-data or replication incidents
- autoscaling or traffic-surge incidents
- infra/config regressions with reusable operational lessons

## Related Procedure Pages

- search Notion for:
  - `Incident declaration`
  - `Alerting and escalation`
  - `On-call`

## Notes

- Prefer the local incident dossiers in this seed-skill directory for fast
  pattern recall.
- Use the Notion pages when you need richer timeline, impact, or action-item
  detail.
- Notion URLs require Morpho workspace access.
