# Internal Development Docs

`docs/internal/` stores internal-only development notes that should live in the repo but stay out of the public docs site and docs tooling flow.

These notes are for development context that would otherwise get lost as code changes over time.

## What belongs here

- Implementation plans
- Refactor plans
- Migration plans
- Architecture notes
- Debugging and investigation notes
- Other development context that is useful to keep in version control

## Folder layout

Create notes under:

`docs/internal/<github-username>/`

For new notes, infer `<github-username>` from the current authenticated GitHub user. If that cannot be resolved, fall back to the best available local git identity.

## File naming

Use dated filenames:

`YYYY-MM-DD-short-topic.md`

Example:

`docs/internal/steipete/2026-01-05-model-config.md`

Do not use this README to track or index individual notes. Keep it focused on the conventions for creating and organizing them.

## Frontmatter

Use YAML frontmatter. At minimum include:

```yaml
---
title: "Model Config Exploration"
summary: "Exploration: model config, auth profiles, and fallback behavior"
author: "Peter Steinberger <steipete@gmail.com>"
github_username: "steipete"
created: "2026-01-05"
---
```

Optional fields commonly used here:

- `status`
- `last_updated`
- `read_when`

## Writing guidance

- Use plain language.
- Prefer preserving dated context over deleting it.
- Update an existing note when it is clearly the same thread of work; create a new dated note when the plan or investigation is meaningfully separate.
- If a note moves folders or is adopted by another contributor later, keep the history clear in git rather than rewriting the repo history.

## Important rules

- Do not put these notes in public `docs/` pages.
- Do not use `experiments/` for this content.
- New implementation plans, refactor plans, and similar development notes should be created here by default.
