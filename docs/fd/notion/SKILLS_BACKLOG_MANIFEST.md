# Skills Backlog DB Manifest (OpenClaw-owned schema)

## Purpose

A single source of truth for skill candidates discovered by the Skills Scout
subsystem. Tracks review state, risk, fit, and links to the per-skill
checklist page.

## Schema-lock discipline

- Humans do not edit DB properties directly.
- OpenClaw is the only actor allowed to:
  - create/rename properties
  - change property types
  - add select/multi-select options
- OpenClaw enforces this via:
  - Notion System Settings `write_lock`
  - service-level `safe_mode` default
  - audited drift healer actions

## Required properties

### Title
- Name (title)

### Text properties (rich_text)
- skill_key (rich_text)
- notes (rich_text) [optional but recommended]

### URL properties
- source_url (url)
- checklist_page_url (url)

### Numbers
- fit_score (number)
- risk_score (number)

### Selects
- trust_tier (select) options:
  - official
  - curated
  - community
  - unknown

- recommended_mode (select) options:
  - safe_only
  - safe_then_confirm
  - confirm_only
  - do_not_install

- status (select) options:
  - New
  - Reviewing
  - Approved to Fork
  - Forked
  - Rejected

### Multi-selects
- pain_point (multi_select) options:
  - Persistent Memory

### Dates
- created_at (date)
- last_updated_at (date)

## Verification rules

- DB must be retrievable via NOTION_DB_SKILLS_BACKLOG_ID
- All required properties must exist
- Property types must match expected type
- Select/multi-select options must include required option set
- Unknown extra properties are allowed (OpenClaw ignores them)
