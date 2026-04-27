---
summary: "Move Claude Code and Claude Desktop local state into OpenClaw with a previewed import"
read_when:
  - You are coming from Claude Code or Claude Desktop and want to keep instructions, MCP servers, and skills
  - You need to understand what OpenClaw imports automatically and what stays archive-only
title: "Migrating from Claude"
---

OpenClaw imports local Claude state through the bundled Claude migration provider. The provider previews every item before changing state, redacts secrets in plans and reports, and creates a verified backup before apply.

<Note>
Onboarding imports require a fresh OpenClaw setup. If you already have local OpenClaw state, reset config, credentials, sessions, and the workspace first, or use `openclaw migrate` directly with `--overwrite` after reviewing the plan.
</Note>

## Two ways to import

<Tabs>
  <Tab title="Onboarding wizard">
    The wizard can offer Claude when it detects local Claude state.

    ```bash
    openclaw onboard --flow import
    ```

    Or point at a specific source:

    ```bash
    openclaw onboard --import-from claude --import-source ~/.claude
    ```

  </Tab>
  <Tab title="CLI">
    Use `openclaw migrate` for scripted or repeatable runs. See [`openclaw migrate`](/cli/migrate) for the full reference.

    ```bash
    openclaw migrate claude --dry-run
    openclaw migrate apply claude --yes
    ```

    Add `--from <path>` to import a specific Claude Code home or project root.

  </Tab>
</Tabs>

## What gets imported

<AccordionGroup>
  <Accordion title="Instructions and memory">
    - Project `CLAUDE.md` and `.claude/CLAUDE.md` content is copied or appended into the OpenClaw agent workspace `AGENTS.md`.
    - User `~/.claude/CLAUDE.md` content is appended into workspace `USER.md`.
  </Accordion>
  <Accordion title="MCP servers">
    MCP server definitions are imported from project `.mcp.json`, Claude Code `~/.claude.json`, and Claude Desktop `claude_desktop_config.json` when present.
  </Accordion>
  <Accordion title="Skills and commands">
    - Claude skills with a `SKILL.md` file are copied into the OpenClaw workspace skills directory.
    - Claude command Markdown files under `.claude/commands/` or `~/.claude/commands/` are converted into OpenClaw skills with `disable-model-invocation: true`.
  </Accordion>
</AccordionGroup>

## What stays archive-only

The provider copies these into the migration report for manual review, but does **not** load them into live OpenClaw config:

- Claude hooks
- Claude permissions and broad tool allowlists
- Claude environment defaults
- `CLAUDE.local.md`
- `.claude/rules/`
- Claude subagents under `.claude/agents/` or `~/.claude/agents/`
- Claude Code caches, plans, and project history directories
- Claude Desktop extensions and OS-stored credentials

OpenClaw refuses to execute hooks, trust permission allowlists, or decode opaque OAuth and Desktop credential state automatically.

## Recommended flow

<Steps>
  <Step title="Preview the plan">
    ```bash
    openclaw migrate claude --dry-run
    ```

    The plan lists everything that will change, including conflicts, skipped items, and sensitive values redacted from nested MCP `env` or `headers` fields.

  </Step>
  <Step title="Apply with backup">
    ```bash
    openclaw migrate apply claude --yes
    ```

    OpenClaw creates and verifies a backup before applying.

  </Step>
  <Step title="Run doctor">
    ```bash
    openclaw doctor
    ```

    [Doctor](/gateway/doctor) checks for config or state issues after the import.

  </Step>
</Steps>

## Source selection

Without `--from`, OpenClaw inspects the default Claude Code home at `~/.claude`, the sampled Claude Code `~/.claude.json` state file, and the Claude Desktop MCP config on macOS.

When `--from` points at a project root, OpenClaw imports only that project's Claude files such as `CLAUDE.md`, `.claude/settings.json`, `.claude/commands/`, `.claude/skills/`, and `.mcp.json`. It does not read your global Claude home during a project-root import.

## Conflict handling

Apply refuses to continue when the plan reports conflicts.

<Warning>
Rerun with `--overwrite` only when replacing the existing target is intentional. Providers may still write item-level backups for overwritten files in the migration report directory.
</Warning>

## Related

- [`openclaw migrate`](/cli/migrate): full CLI reference, plugin contract, and JSON shapes.
- [Onboarding](/cli/onboard): wizard flow and non-interactive flags.
- [Doctor](/gateway/doctor): post-migration health check.
- [Agent workspace](/concepts/agent-workspace): where `AGENTS.md`, `USER.md`, and skills live.
