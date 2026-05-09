---
name: slothlee-dev
description: "Develop the Sloth Lee Discord-bot platform — read the codebase, edit files, run tests, open PRs. Use this whenever the operator asks to *change*, *fix*, *add*, *refactor*, or *test* code in `slothyproject/sloth-command-platform`. For runtime ops (drive the bot, change settings) use the `slothlee` skill instead."
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "🛠️",
        "requires": { "bins": ["git", "gh", "curl", "python3"] },
        "primaryEnv": "GH_TOKEN",
        "envVars":
          [
            { "name": "GH_TOKEN", "label": "GitHub PAT with `repo` scope on slothyproject", "secret": true },
            { "name": "SLOTHLEE_REPO_PATH", "label": "Local path of the cloned repo", "default": "/root/.openclaw/workspace/sloth-command-platform" },
            { "name": "SLOTHLEE_REPO_REMOTE", "label": "GitHub repo to clone", "default": "slothyproject/sloth-command-platform" }
          ]
      }
  }
allowed-tools: ["bash", "coding-agent", "github", "git"]
---

# Sloth Lee Development Skill

Pairs with the built-in `coding-agent`, `github`, and `git` skills. This skill is the *map* of the Sloth Lee codebase — what's where, how to run things, and the conventions the project actually follows. Lean on `coding-agent` for the heavy lifting (edits, refactors, tests).

## When to use

✅ Operator says any of:
- "Fix bug X in the dashboard / bot"
- "Add a new feature"
- "Refactor / rename / clean up Y"
- "Run the tests"
- "Open a PR for Z"
- "Why does this fail?"
- "Read this file and explain it"

❌ Don't use this skill when:
- The operator wants to *drive* the bot (ban a user, reload a cog) — use `slothlee` skill
- The operator asks about deployments / status — use `slothlee.deploy_status` then this skill if action is needed
- The task is in some other codebase — use `coding-agent` directly

## First-time setup (clone the repo)

The Openclaw container persists `/root/.openclaw/workspace/` on a Railway volume. Clone the Sloth Lee repo into it on first run:

```bash
WORKSPACE="${SLOTHLEE_REPO_PATH:-/root/.openclaw/workspace/sloth-command-platform}"
REMOTE="${SLOTHLEE_REPO_REMOTE:-slothyproject/sloth-command-platform}"

if [ ! -d "$WORKSPACE/.git" ]; then
  mkdir -p "$(dirname "$WORKSPACE")"
  gh repo clone "$REMOTE" "$WORKSPACE"
  cd "$WORKSPACE"
  git config user.email "openclaw@slothlee.xyz"
  git config user.name "Openclaw"
fi
cd "$WORKSPACE"
git fetch origin && git checkout main && git pull --ff-only
```

Always start a session with `git fetch origin && git pull` so you're working from current main.

## Repo layout

```
sloth-command-platform/
├── AGENTS.md                       <-- READ THIS FIRST every session
├── CLAUDE.md                       <-- agent instructions (this is for you)
├── dashboard/                      <-- Flask backend + Jinja templates
│   ├── app.py                      <-- Flask app factory + blueprint mounts
│   ├── routes/
│   │   ├── api.py                  <-- 18k LoC of /api/* (browse, don't blanket-read)
│   │   ├── public_api.py           <-- /api/public/v1/* (bearer token)
│   │   ├── ai_chat.py              <-- /api/ai/chat orchestrator
│   │   ├── developer_portal.py     <-- /developer/* UI
│   │   └── ...
│   ├── services/
│   │   ├── ai_tools.py             <-- 58 tools registry + execute_tool_call
│   │   ├── ai_modes.py             <-- chat-mode catalog
│   │   ├── ai_prompt.py            <-- PromptBuilder
│   │   ├── bot_contract.py         <-- bot↔dashboard wire schemas
│   │   ├── slothlee_api.py         <-- bot REST proxy
│   │   └── ...
│   ├── models.py                   <-- 50+ SQLAlchemy tables (~3700 lines)
│   ├── templates/                  <-- Jinja templates
│   └── static/                     <-- compiled frontend output gets copied here
├── frontend/                       <-- Vite + React 18 dashboard SPA
├── homepage/                       <-- Next.js 16 marketing site
├── packages/ui/                    <-- @sloth/ui shared workspace package
├── tests/                          <-- pytest tests
├── scripts/                        <-- utility scripts (bump_version.py etc.)
├── Dockerfile                      <-- 3-stage prod build
└── docs/
    ├── OPENCLAW_RAILWAY_RUNBOOK.md
    └── ...
```

## Development workflow

### Read before write

`AGENTS.md` at the repo root has project-specific guidance the LLM doesn't know from training. Read it at the start of every session.

### Branching

`main` is protected by convention (Railway-native auto-deploy fires on push to main). Always work on a feature branch:

```bash
git checkout main && git pull --ff-only
git checkout -b feat/<short-description>     # or fix/, refactor/, chore/, docs/
```

Conventional Commits style for branch + commit prefixes (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`).

### Make changes

Use the `coding-agent` skill for multi-file work. For one-line fixes, just edit directly.

### Run the test suite

```bash
cd "$SLOTHLEE_REPO_PATH"
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python -m pytest tests/test_<changed_area>.py --tb=short -q
# or full suite (slower)
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python -m pytest --tb=short -q
```

If your change adds behaviour, add a test. The project is heavily tested on the AI-spine and public-API surfaces; uncovered areas (per the audit) include workflow_worker, stripe_billing, audit_hash_chain, scheduled_ai_worker leader-lock semantics.

### Lint

```bash
python -m ruff check <changed_files>
```

`ruff.toml` excludes `dissident_panel`, `vault`, `frontend`, `scripts`, `.github`, `node_modules`, `__pycache__`, `migrations` — don't fight ruff in those.

### Commit

```bash
git add <specific files>     # NOT `git add .` — repo has gitignored scratch scripts at root
git commit -m "feat(area): one-line summary

Why this change is being made.

Body explains the non-obvious decisions or the bug being fixed."
```

Pre-commit hook runs lint + URL-for + mojibake checks. **Never** use `--no-verify` to bypass — fix the underlying issue.

### Push + open PR

```bash
git push -u origin HEAD
gh pr create --base main --title "<conventional-commit title>" --body "$(cat <<'EOF'
## What

...

## Why

...

## Test plan

- [ ] ...
EOF
)"
```

PR titles must follow Conventional Commits — the auto-version workflow parses them.

## Conventions

- **Type hints**: Python 3.12+ syntax (`list[int]`, `dict[str, X]`, `X | None`).
- **Imports**: stdlib first, third-party second, dashboard.* last. Inside functions only when avoiding circular imports.
- **Errors**: catch specific exceptions; broad `except Exception` requires `# noqa: BLE001` and a comment explaining why.
- **Logging**: `log = logging.getLogger(__name__)` at module top. `log.warning(...)` for recoverable, `log.exception(...)` inside `except` blocks for unexpected.
- **DB**: SQLAlchemy 2.0 style preferred (`db.session.get(Model, id)` over `Model.query.get(id)`).
- **Tests**: `tests/test_<topic>.py`, pytest, fixtures in `tests/conftest.py`. SQLite in-memory.

## Common pitfalls

- The `Guild` model has **no `owner_user_id` field** — use `owner_discord_id`. (Caught a latent bug recently.)
- `lazy="dynamic"` SQLAlchemy relationships: their default `order_by` is **appended** to, not replaced. Don't `.order_by(desc(...))` on a dynamic relationship and expect the desc to win — query the table directly.
- Discord IDs are stored as **strings** on User/Guild (Discord snowflakes overflow JS Number — strings are safer). Coerce when comparing.
- `ai_tools.execute_tool_call()` is the single dispatch point for AI-driven actions. Every new tool family registers via `register_tool_family(...)`. Don't add to the dispatcher's if/elif — there isn't one any more.
- `requirements.txt` floors must stay below `<X.0.0` upper bounds. CVE bumps need both a floor bump and a sanity-check that the upper bound permits the floor.
- The marketing site (`homepage/`) uses Next.js with `basePath: "/homepage"` because Flask serves it under that path in prod. CI tests have to mirror that or asset 404s flood the gates.

## CI

GitHub Actions runs on every PR:
- Lint (ruff) — must pass
- Backend API tests (pytest) — must pass
- Frontend Type Check (tsc) — must pass
- Build Frontend (Vite) — must pass
- Homepage Next.js build — must pass
- Other checks (a11y, lighthouse, gitleaks) — informational; some currently red on infra issues

`main` is unprotected so PRs CAN merge with red checks, but don't unless you understand why each red check is unrelated.

## Deploying

Railway auto-deploys on push to `main` for `Sloth Lee Web` and `Sloth Command Bot` services. After your PR merges, watch the Railway logs. If auto-deploy doesn't fire, the operator (or this skill via `slothlee.redeploy`) can trigger it manually.

## Out of scope for this skill

- Editing the Openclaw fork itself — use `coding-agent` directly with a different repo path.
- Editing third-party deps in `node_modules` or installed Python packages.
- Anything in `dashboard/static/homepage/` (that's compiled output, not source — edit `homepage/` instead).
