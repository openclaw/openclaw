---
doc_id: rbk_machine_style_guide
title: Machine-first runbook style guide
type: reference_card
lifecycle_state: active
owners:
  primary: platform
tags:
  - style-guide
  - machine-first
  - runbook-memory
aliases:
  - runbook-style-guide
  - machine-style-guide
  - machine-first runbook style guide
scope:
  service: runbook-memory
  feature: authoring
  plugin: runbook-memory
  environments:
    - all
validation:
  last_validated_at: "2026-04-05"
  review_interval_days: 30
provenance:
  source_type: human_or_agent
  source_ref: docs-refactor-2026-04-05
retrieval:
  synopsis: Canonical authoring rules for machine-first runbooks, injected workspace docs, and retrieval-friendly frontmatter.
  hints:
    - naming convention
    - frontmatter vocabulary
    - heading vocabulary
    - command citation
    - path citation
    - doc_id
    - aliases
    - retrieval.hints
    - retrieval.not_for
    - runbook filenames
    - canonical tokens
  not_for:
    - human prose style
    - marketing copy
  commands: []
---

# Purpose

Keep runbooks compact, searchable, and stable for GPT-5+ retrieval and prompt injection.

# Naming

- Filenames use `__` separators and canonical tokens: `<type>__svc-<service>__plg-<plugin>__feat-<feature>__env-<env>__<topic>.md`.
- Omit empty scope segments.
- Canonical tokens are lowercase kebab-case.
- Use one canonical token for each service, plugin, feature, environment, and command name.

# Frontmatter vocabulary

- `doc_id` is identity.
- `title` is the human-readable label.
- `tags` contains broad categories.
- `aliases` contains the small set of search synonyms.
- `scope.service`, `scope.plugin`, `scope.feature`, and `scope.environments` are the canonical scope tokens.
- `validation.last_validated_at` and `validation.review_interval_days` are the freshness inputs.
- `retrieval.synopsis` is the one-line ranking summary.
- `retrieval.hints` contains short lexical hints that improve search.
- `retrieval.not_for` contains common false-positive routes.
- `retrieval.commands` contains exact command literals that should rank this doc.

# Heading vocabulary

Use these headings in this order when they apply:

1. `Purpose`
2. `Aliases`
3. `When to use`
4. `Prerequisites`
5. `Signals / symptoms`
6. `Triage`
7. `Mitigation`
8. `Validation`
9. `Rollback`
10. `Related runbooks`
11. `Change history`

# Writing rules

- Put synonyms in `aliases`, `tags`, or `retrieval.hints`, not scattered through prose.
- Keep sections short and chunkable.
- Preserve exact error codes, config keys, commands, paths, and flags.
- Prefer one canonical term per concept. Do not alternate between near-synonyms in body text.
- Keep volatile notes out of the top of injected files so prompt caching has a stable prefix.

# Dates and citations

- Dates use ISO format: `YYYY-MM-DD`.
- Commands use fenced `bash` blocks or inline backticks with full flags.
- Paths use inline backticks and absolute paths only when the doc is explicitly host-local.
- Related docs cite `doc_id` first, then canonical path when needed.

# Negative routing

- Use `retrieval.not_for` when a nearby but wrong query often collides with this doc.
- Keep each `not_for` item short and literal.

# Freshness

- Freshness ranking comes from `validation.last_validated_at`, `validation.review_interval_days`, and indexed document update time.
- Stale docs should rank lower unless the query explicitly asks for old, deprecated, archived, or previous material.
