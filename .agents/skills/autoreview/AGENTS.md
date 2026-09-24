# Autoreview Skill

- Canonical source: `openclaw/agent-skills`, under `skills/autoreview`.
- Before editing any copy, fast-forward a checkout of `openclaw/agent-skills` from `origin/main`.
- Make and validate shared changes in canonical `skills/autoreview` first, then sync the complete directory into downstream repos.
- Never create repo-local behavior variants; downstream differences belong in repo-level validation, not the skill.
- `openclaw/openclaw` vendors `.agents/skills/autoreview/`; after canonical changes, follow up with a mirror-sync PR there.
