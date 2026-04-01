# Contribution Notes

This template set is designed to be copied into an upstream repository without dragging along a live private workspace.

## What To Contribute

Safe candidates:

- `workspace/AGENTS.md`
- `workspace/BOOTSTRAP.md`
- `workspace/IDENTITY.md`
- `workspace/SOUL.md`
- `workspace/USER.md`
- `workspace/TOOLS.md`
- `workspace/MEMORY.md`
- `workspace/context/`
- `workspace/context/HARNESS_TOOLS.md` when exporting the public bundle
- `workspace/agents/claude-style/`
- `workspace/agents/coordinator/AGENTS.md`
- `workspace/agents/general-purpose/AGENTS.md`
- `workspace/agents/explore/AGENTS.md`
- `workspace/agents/plan/AGENTS.md`
- `workspace/agents/researcher/AGENTS.md`
- `workspace/agents/verification/AGENTS.md`
- `workspace/memory/current-task.md`
- `workspace/memory/preferences.json`
- `workspace/memory/facts.json`
- `workspace/.gitignore`
- `workspace/.openclaw/extensions/auto-session-closeout/`
- `scripts/openclaw_harness.py`
- `scripts/test_openclaw_harness.py`
- `scripts/enable_auto_session_closeout_plugin.py`
- `scripts/test_enable_auto_session_closeout_plugin.py`
- `scripts/install_public_workspace_template.sh`
- `scripts/package_public_workspace.sh`
- `scripts/nightly_dream.sh`
- `scripts/install_nightly_dream_cron.sh`
- `scripts/upsert_nightly_dream_cron.py`
- `scripts/archive_stale_weixin_queue.py`

## What Not To Contribute

Do not upstream:

- live `memory/YYYY-MM-DD.md` notes
- `memory/private/`
- personal `MEMORY.md` contents
- user-specific agent folders
- generated reports, drafts, screenshots, or media assets
- local runtime artifacts and dependency folders

## Suggested Upstream Placement

Pick one of these patterns in the target repo:

- `examples/workspace-template/`
- `templates/workspace/`
- `docs/workspace-template/`

If the upstream repo already has an agent layout, adapt names rather than forcing a duplicate structure.

## Review Checklist Before Commit

- no personal names
- no private business logic
- no API keys or hostnames
- no hardcoded absolute filesystem paths
- no references to a specific user or private workflow
- verification language stays generic
