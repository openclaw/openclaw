---
name: antigravity-cli
description: "Antigravity CLI (agy) — terminal-based AI agent with TUI, one-shot prompts, artifact review, plugin management, and conversation control."
homepage: https://antigravity.google/
metadata: { "openclaw": { "emoji": "🪂", "requires": { "bins": ["agy"] } } }
---

# Antigravity CLI (agy)

Use Google Antigravity in headless one-shot mode or interactive TUI. The binary is `agy`, not `antigravity`.

## Quick start

- Headless one-shot: `agy --print "Answer this question..."`
- Headless with model: `agy --print "Prompt..."` (model selected via `/model` in TUI)
- Continue last session: `agy --continue` (alias: `agy -c`)
- Resume by ID: `agy --conversation <id>`
- Interactive start with prompt: `agy --prompt-interactive "Summarize this codebase"` (alias: `agy -i`)
- stdin input: `cat notes.md | agy --prompt-interactive "Analyze"`

## Options

| Flag                             | Alias | Purpose                                              |
| -------------------------------- | ----- | ---------------------------------------------------- |
| `--print <prompt>`               | `-p`  | Run single prompt non-interactively, print response  |
| `--prompt <prompt>`              |       | Alias for `--print`                                  |
| `--print-timeout`                |       | Timeout for print mode (default: 5m0s)               |
| `--continue`                     | `-c`  | Continue most recent conversation                    |
| `--conversation <id>`            |       | Resume specific conversation by ID                   |
| `--prompt-interactive`           | `-i`  | Run initial prompt interactively, keep session alive |
| `--sandbox`                      |       | Run with terminal sandbox restrictions enabled       |
| `--dangerously-skip-permissions` |       | Auto-approve all tool requests without prompting     |
| `--add-dir <path>`               |       | Add workspace directory (repeatable)                 |
| `--log-file <path>`              |       | Override log file location                           |

## Subcommands

- `agy install` — Configure environment paths and shell settings
  - `--skip-aliases` — Skip shell profile alias purging
  - `--skip-path` — Skip shell profile PATH appending
- `agy plugin` — Manage plugins (install, uninstall, list, enable, disable, validate, link)
  - `agy plugin list` — List installed plugins
  - `agy plugin install <target>` — Install a plugin (supports `plugin@marketplace`)
  - `agy plugin uninstall <name>` — Remove a plugin
  - `agy plugin import [source]` — Import plugins from gemini or claude
  - `agy plugin enable/disable <name>` — Toggle plugin
  - `agy plugin validate [path]` — Validate a plugin directory
  - `agy plugin link <mp> <target>` — Link to a marketplace
- `agy update` — Update CLI to latest version
- `agy changelog` — Show changelog and release notes

## Configuration

- Settings file: `~/.gemini/antigravity-cli/settings.json`
- Keybindings: `~/.gemini/antigravity-cli/keybindings.json`
- MCP config: `~/.gemini/antigravity-cli/mcp_config.json`
- Conversations: `~/.gemini/antigravity-cli/conversations/`
- History: `~/.gemini/antigravity-cli/history.jsonl`

## Interactive TUI (slash commands)

Launch with `agy` in a project directory for the full TUI. Type `/` inside the prompt box to open the typeahead command selection menu.

| Command | Alias | Purpose |
|-|-|-|
| `/add-dir <path>` | — | Add a directory path to the active workspace |
| `/agents` | — | Open Agent Manager Panel to monitor background subagents |
| `/btw <query>` | — | Ask a side question in the background without interrupting main conversation |
| `/clear` | — | Clear the terminal and reset active conversation contexts |
| `/config` | `/settings` | Open the interactive Settings Editor Overlay |
| `/diff` | — | Show unified diff of all modified workspace files |
| `/exit` | — | Close the TUI session and restore your host shell |
| `/fast` | — | Enable fast mode (bypass reasoning plans) for quick actions |
| `/fork` | `/branch` | Clone the current conversation thread into a new parallel session |
| `/hooks` | — | Browse active pre-flight/post-format script hooks |
| `/keybindings` | — | Open the interactive Keyboard Shortcut Editor |
| `/logout` | — | Disconnect profile and purge auth tokens from secure keyring |
| `/mcp` | — | Open the Model Context Protocol (MCP) server manager |
| `/model` | — | Choose preferred reasoning model (persists across sessions) |
| `/open <path>` | — | Force path to open inside default system editor |
| `/permissions` | — | Switch global permission presets (`request-review`, `always-proceed`, `strict`) |
| `/planning` | — | Enable multi-turn plan generation mode for complex tasks |
| `/rename <name>` | — | Rename the current session thread |
| `/resume` | `/switch`, `/conversation` | Open conversation picker to select and load previous threads |
| `/rewind` | `/undo` | Roll back conversation history to a previous message |
| `/skills` | — | Browse loaded local and global Agent Skills |
| `/statusline` | — | Open the Status Bar customization overlay |
| `/tasks` | — | Open Task Manager Panel to monitor background shell execution logs |
| `/title [on/off]` | — | Toggle or set terminal window title updates |
| `/usage` | — | Launch the offline developer help manual inside the terminal |

## Essential Keybindings

Most-used keyboard shortcuts inside the TUI.

| Key | Action |
|-|-|
| `Esc` | Cancel stream, close panels, clear prompt (global escape) |
| `Ctrl+C` | Terminate CLI session |
| `Ctrl+L` | Clear terminal buffer |
| `Enter` | Submit prompt / confirm selection |
| `Shift+Enter` / `Ctrl+J` | Insert newline without submitting |
| `Ctrl+R` | Open Artifact Review Panel |
| `Ctrl+G` | Edit prompt in `$EDITOR` |
| `Ctrl+V` | Paste media from clipboard |
| `Ctrl+O` | Toggle tool reasoning output |
| `Ctrl+K` | Fast-approve pending subagent action |
| `Alt+J` | Teleport to next subagent awaiting approval |
| `Ctrl+A` / `Ctrl+E` | Cursor to line start / end |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo text edit |
| `y` / `n` | Approve / reject tool command or artifact |
| `Shift+A` | Approve all artifacts (review panel) |
| `Ctrl+D` | Exit CLI (same as `/exit`) |
| `Ctrl+Z` (terminal) | Suspend CLI to background |

## Artifact Review Workflow

When the agent proposes file changes, press `Ctrl+R` to open the Artifact Review Panel.

1. **Navigate** files with `↑` / `↓`
2. **Preview** individual file inline with `p` (12-line truncated view)
3. **Detail view**: Press `Enter` on a file to open full-screen diff
4. **Approve** with `y`, **reject** with `n`
5. **Bulk approve/reject** with `Shift+A` / `Shift+R`
6. Press `Esc` to save state and return to the prompt

Files are organized by type:
- **Actionable code files**: require explicit approve/reject
- **Media drawer**: images/videos grouped separately, expand with `Enter`

## Interaction Tips

- `!` prefix runs terminal commands directly in the prompt
- `?` shows help and lists all slash commands
- `@` in the prompt triggers file path autocomplete suggestions
- `Esc Esc` clears the prompt box (when no streaming is active)
- `\` at end of line + `Enter` inserts a clean newline (universal multiline escape)
- Set verbosity to `low` via `/config` to reduce tool call noise

## Platform

- Antigravity CLI is the lightweight TUI surface, sharing the same agent core as Antigravity 2.0 (visual editor).
- **Settings sync**: preferences, permissions, and security config synchronize automatically between CLI and Antigravity 2.0.
- **Conversation export**: active CLI conversations can be exported to Antigravity 2.0 for visual orchestration.
- **Remote use**: native SSH, tmux, and terminal multiplexer support; ideal for headless/server workflows.
- **Subagent permissions**: the main agent decides which tools and permissions subagents get, including MCP tool access and file write capabilities.

## Skills paths

| Scope | Path |
|-------|------|
| Global shared | `~/.gemini/antigravity-cli/skills/` |
| Workspace project | `.agents/skills/` |

## Notes

- First launch prompts for color scheme, rendering mode, and workspace trust.
- Auth uses OS native keyring (Apple Keychain, Linux Secret Service). Falls back to browser OAuth.
- SSH sessions trigger a manual URL authorization flow (print URL → open in browser → paste code back).
- Auto-saves resume command on exit — prints the exact `agy --continue` or `agy --conversation <id>` needed to resume.
- Avoid `--dangerously-skip-permissions` for untrusted codebases.
- Keybindings customization: edit `~/.gemini/antigravity-cli/keybindings.json`. Delete to reset to defaults. `cli.exit` and `cli.enter` cannot be disabled.

## Documentation

**Getting started:**
- [Installation & Auth](https://antigravity.google/docs/cli-install) — Setup, configuration, enterprise parameters
- [CLI Overview](https://antigravity.google/docs/cli-overview) — Platform comparison, integration features, migration
- [Getting Started](https://antigravity.google/docs/cli-getting-started) — Onboarding roadmap, first-launch setup
- [Tutorial](https://antigravity.google/docs/cli-tutorial) — First agent-assisted workflow walkthrough

**Reference:**
- [CLI Reference](https://antigravity.google/docs/cli-reference) — Slash commands, keybindings, JSON config parameters
- [CLI Features](https://antigravity.google/docs/cli-features) — Plugins, sandbox, subagents
- [Using AGY CLI](https://antigravity.google/docs/cli-using) — Settings, quick tips, default keybindings
- [Prompting & Interaction](https://antigravity.google/docs/cli-prompting) — Multiline composition, media, interrupts
- [Reviewing Artifacts](https://antigravity.google/docs/cli-artifacts) — Artifact review workflow

**Migration:**
- [Migrating from Gemini CLI](https://antigravity.google/docs/gcli-migration) — `agy plugin import gemini` converts legacy extensions
