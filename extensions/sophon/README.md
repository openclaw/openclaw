# Sophon Plugin

Sophon adds task, project, and note tools backed by Supabase.

## Setup

Configure these env vars in `~/.openclaw/openclaw.json` under `env.vars`:

- `SOPHON_SUPABASE_URL`
- `SOPHON_SUPABASE_KEY`
- `SOPHON_REFRESH_TOKEN` (preferred) or `SOPHON_USER_TOKEN`

## Tools

- Tasks: `sophon_list_tasks`, `sophon_get_task`, `sophon_create_task`, `sophon_update_task`, `sophon_complete_task`, `sophon_archive_task`
- Projects: `sophon_list_projects`, `sophon_get_project`, `sophon_create_project`, `sophon_update_project`, `sophon_archive_project`
- Notes: `sophon_list_notes`, `sophon_get_note`, `sophon_create_note`, `sophon_update_note`, `sophon_archive_note`
- Summary/search: `sophon_dashboard`, `sophon_search`

## Auth Notes

If refresh auth fails, re-auth in Sophon and update `SOPHON_REFRESH_TOKEN`, or set `SOPHON_USER_TOKEN` as a fallback.
