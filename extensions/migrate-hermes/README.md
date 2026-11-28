# Hermes Migration

Import supported Hermes model configuration, workspace memory, skills, and MCP
servers into OpenClaw. The provider can also import supported credentials with
your consent. Unsupported state is reported for manual review.

## Get started

Preview the import:

```bash
openclaw migrate hermes --dry-run
```

Discovery follows your Hermes home and active profile; use `--from <path>` to
select another source. Review the plan, then run
`openclaw migrate apply hermes` and follow the prompts. Apply backs up existing
OpenClaw state before making changes.

Hermes plugins, sessions, and scheduled jobs are not activated automatically.
Credential import has a separate consent step.

See [Migrating from Hermes](https://docs.openclaw.ai/install/migrating-hermes) for
coverage, conflicts, and credential handling.
