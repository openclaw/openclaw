# Gesahni Operator Orchestration

Use one operator entry point for live website workflow routing: call `get_website_orchestration_plan`, then delegate the next lane with `sessions_send`.

Do not use `sessions_spawn` for this workflow. The operator should target existing specialist agents:

- `agent:gesahni-researcher:main` for `gesahni-researcher` research work and `research_summary` artifacts.
- `agent:gesahni-builder:main` for `gesahni-builder` sitemap, copy, and build work that produces `sitemap`, `copy_draft`, and `code_draft` artifacts.
- `agent:gesahni-reviewer:main` for `gesahni-reviewer` review work and `review_notes` artifacts.

The operator must reread workflow state before acting and preserve `preview_state` and `preview_latest_result` in the final handoff. Do not call specialist write tools directly from the operator role.
