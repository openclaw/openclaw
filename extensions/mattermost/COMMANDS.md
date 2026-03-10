# Mattermost Slash Commands

All native slash commands registered by OpenClaw in Mattermost.

Built-in commands use the `oc_` prefix to avoid collisions with Mattermost's
own slash commands (e.g. `/help`, `/status`).

## Built-in Commands

| Command | Description | Hint |
|---------|-------------|------|
| `/oc_status` | Show session status (model, usage, uptime) | |
| `/oc_model` | View or change the current model | `[model-name]` |
| `/oc_new` | Start a new conversation session | |
| `/oc_help` | Show available commands | |
| `/oc_think` | Set thinking/reasoning level | `[off\|low\|medium\|high]` |
| `/oc_reasoning` | Toggle reasoning mode | `[on\|off]` |
| `/oc_verbose` | Toggle verbose mode | `[on\|off]` |

## Plugin Commands (memory-episodes / memory-mem0)

These are registered without the `oc_` prefix since they don't collide with
built-in Mattermost commands.

| Command | Description | Hint |
|---------|-------------|------|
| `/clear` | Finalize session and clear context | `[--discard]` |
| `/recall` | Search long-term and session memory | `[query]` |
| `/forget` | Remove memories | `[query]` |
| `/memory` | Memory dashboard | |
| `/reset-all` | Reset all active agent sessions | `[--discard]` |

## Skill Commands

Skill commands are registered per-agent with the `oc_` prefix. When multiple
agents share the same team, each agent gets its own numbered variant
(e.g. `/oc_github`, `/oc_github_2`, `/oc_github_3`, ...).

| Command | Description |
|---------|-------------|
| `/oc_coding_agent` | Delegate coding tasks to Codex, Claude Code, or Pi agents |
| `/oc_gemini` | Gemini CLI for one-shot Q&A, summaries, and generation |
| `/oc_gh_issues` | Fetch GitHub issues, spawn sub-agents to implement fixes and open PRs |
| `/oc_github` | GitHub operations via `gh` CLI: issues, PRs, CI runs, code review |
| `/oc_healthcheck` | Host security hardening and risk-tolerance configuration |
| `/oc_secureclaw` | Security skill for OpenClaw agents (7-framework aligned) |
| `/oc_self_improving_agent_with_self` | Self-reflection, self-criticism, and learning from corrections |
| `/oc_session_logs` | Search and analyze your own session logs using jq |
| `/oc_skill_creator` | Create or update AgentSkills |
| `/oc_weather` | Get current weather and forecasts via wttr.in or Open-Meteo |

## Notes

- Skill commands are only registered when `commands.nativeSkills` is enabled in
  the mattermost channel config.
- The numbered suffixes (`_2`, `_3`, ...) appear because each Mattermost bot
  user (agent) registers its own copy of the command for the same team. Only the
  first agent gets the base name; subsequent agents get incrementing suffixes.
- Plain text commands (e.g. typing `/new` as a message) still work via the
  regular message monitor — they don't require native slash command registration.
