---
name: openclaw-handbook
description: "OpenClaw itself: what it can do, setup, connecting channels and models, permissions, config, and Gateway fixes. Load before answering questions about OpenClaw."
---

# OpenClaw handbook

OpenClaw is an open-source AI assistant that runs on the person's own hardware and answers in the chat apps they already use. One Gateway process on the Gateway host runs the agents, channels, plugins, and the Control UI. The person chooses and signs in to the models. There is no hosted service in the middle.

## Quick start

- `openclaw onboard` runs guided first setup. The person runs it in a terminal on the Gateway host.
- `openclaw configure` edits selected settings in an existing setup.
- `openclaw status` shows channel and session health. It is read-only.
- `openclaw help <command>` lists the subcommands and flags of one command.

## Key paths

- State directory: `~/.openclaw`. `OPENCLAW_STATE_DIR` overrides it.
- Config file: `~/.openclaw/openclaw.json` (JSON5). `openclaw config file` prints the active path.
- Workspace: `~/.openclaw/workspace`, set by `agents.defaults.workspace`.
- Logs: `openclaw logs`. If RPC is down, read `~/.openclaw/logs/openclaw-<YYYY-MM-DD>.log`.
- Control UI: `http://127.0.0.1:18789` on the Gateway host.
- Docs root: the `Docs:` line of your Documentation prompt section.

A docs route such as `channels/index` names a page under the docs root. The `openclaw-docs` skill has the path and web URL rules.

## Load the route before you answer

Find the request in this list. Load the named skill or read the named page before you give details. Cite the page route or URL. Use the exact commands, config keys, and names the page gives.

- Anything not listed here, or which page covers a topic: `openclaw-docs` skill
- Connect a chat app such as Telegram, WhatsApp, or Discord: docs `channels/index`, then `channels/<name>`, and `channels/pairing` for sender approval.
- Pair a phone or node, or fix a Control UI that cannot connect: `node-connect` skill
- Use or host the Control UI, dashboards, or a Gateway behind Tailscale: `control-ui` skill
- Models, providers, API keys: docs `providers/index`, `concepts/models`. Run `openclaw models status`.
- Permission modes and approvals: docs `tools/permission-modes`, `tools/exec-approvals`
- A config field: `gateway` tool `config.schema.lookup` when exposed. Otherwise `openclaw config schema`, `openclaw config get <path>`, docs `gateway/configuration-reference`.
- Find or install plugins, skills, or Templates from ClawHub: `clawhub` skill
- Plugins already installed: `openclaw plugins list`, docs `tools/plugin`
- Write or fix a skill: `skill-creator` skill
- A skill does not show up: `openclaw skills check`, docs `tools/skills`
- Harden or audit the host: `healthcheck` skill
- Automations and scheduled jobs: docs `automation/index`, `automation/cron-jobs`
- Memory: docs `concepts/memory`
- Connect MCP servers to OpenClaw: docs `tools/mcp`. To call an MCP server directly, `mcporter` skill.
- Share an agent as a Template: `create-template` skill
- A custom agent avatar: `create-blobster` skill
- A persistent dashboard widget: `visualize` skill
- Hand coding work to Codex, Claude Code, or OpenCode: `coding-agent` skill
- Update OpenClaw: docs `install/updating`
- Install or first run: docs `start/getting-started`, `start/onboarding`, `help/faq-first-run`
- Something is broken: [troubleshooting.md](references/troubleshooting.md). If the Gateway does not start, also read docs `help/troubleshooting` and `gateway/troubleshooting`.
- Which commands exist: `openclaw --help`, `openclaw help <command>`, docs `cli/index`

A routed skill that is missing from your skill list is disabled or not eligible on this Gateway. Find its topic with the `openclaw-docs` skill instead.

## Before you say OpenClaw cannot do something

Never answer "OpenClaw can't do that" from memory or from the silence of this skill. Check these in order and stop at the first answer:

1. `openclaw --help` and `openclaw help <command>`. These work offline.
2. The docs map in the `openclaw-docs` skill, and the `summary:` frontmatter lines of local docs pages.
3. With network access, search `https://docs.openclaw.ai/llms.txt`, one line per page. Do not read it whole. `openclaw docs <query>` searches the live docs and has no offline fallback.

If all three find nothing, say the docs do not cover it. Do not say it is impossible. A tool missing from this session is a limit of the session, not of OpenClaw.

## Answer honestly

- When the docs are silent or disagree with what you observe, say so and check the source.
- When you cannot reach any docs, say so and mark the answer unverified.
- When only the person can act, say so plainly. Examples are a Tailscale admin console change, an app store install, an OAuth browser sign-in, a BotFather token, and an OS permission prompt.

## Config, access, and skill changes

- For config edits and validation, follow the config command guidance in `cli/config`.
- For read-only Doctor diagnosis and repairs, follow [troubleshooting.md](references/troubleshooting.md) and `cli/doctor`.
- For handling credentials and SecretRefs, see `gateway/secrets`.
- For access restrictions and approvals, follow `tools/permission-modes` and `tools/exec-approvals`.
- For skill changes, see `tools/skills#snapshots-and-refresh`. With watching enabled, an existing session can pick up changes to eligible file-backed skills on its next turn.
