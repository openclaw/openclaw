---
summary: "CLI reference for importing state from another agent system"
read_when:
  - You want to migrate from Hermes or another agent system into OpenClaw
  - You are adding a plugin-owned migration provider
title: "Migrate"
---

# `openclaw migrate`

Import state from another agent system through a plugin-owned migration provider.

```bash
openclaw migrate list
openclaw migrate hermes --dry-run
openclaw migrate hermes
openclaw migrate apply hermes --yes
openclaw migrate apply hermes --include-secrets --yes
```

## Safety model

`openclaw migrate` is preview-first. The provider returns an itemized plan before anything changes, including conflicts, skipped items, and sensitive items.

`openclaw migrate apply <provider>` previews the plan and prompts before changing state unless `--yes` is set. In non-interactive mode, apply requires `--yes`. With `--json` and no `--yes`, apply prints the JSON plan and does not mutate state.

Apply creates and verifies an OpenClaw backup before applying the migration. If no local OpenClaw state exists yet, the backup step is skipped and the migration can continue. To skip a backup when state exists, pass both `--no-backup` and `--force`.

Apply mode refuses to continue when the plan has conflicts. Review the plan, then rerun with `--overwrite` if replacing existing targets is intentional. Providers may still write item-level backups for overwritten files in the migration report directory.

Secrets are never imported by default. Use `--include-secrets` to import supported credentials.

## Hermes

The bundled Hermes provider detects Hermes state at `~/.hermes` by default. Use `--from <path>` when Hermes lives elsewhere.

The Hermes migration can import:

- default model configuration from `config.yaml`
- `SOUL.md` and `AGENTS.md` into the OpenClaw agent workspace
- `memories/MEMORY.md` and `memories/USER.md` by appending them to workspace memory files
- skills with a `SKILL.md` file from `skills/<name>/`
- supported API keys from `.env`, only with `--include-secrets`

Supported Hermes `.env` keys include `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, and `DEEPSEEK_API_KEY`.

After applying a migration, run:

```bash
openclaw doctor
```

## Plugin contract

Migration sources are plugins. A plugin declares its provider ids in `openclaw.plugin.json`:

```json
{
  "contracts": {
    "migrationProviders": ["hermes"]
  }
}
```

At runtime the plugin calls `api.registerMigrationProvider(...)`. The provider implements `detect`, `plan`, and `apply`; core owns CLI orchestration, backup policy, prompts, JSON output, and conflict preflight. Core passes the reviewed plan into `apply(ctx, plan)`, and providers may rebuild the plan only when that argument is absent for compatibility. Provider plugins can use `openclaw/plugin-sdk/migration` for item construction and summary counts, plus `openclaw/plugin-sdk/migration-runtime` for conflict-aware file copies and migration reports.
