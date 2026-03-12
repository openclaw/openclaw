# Project Init Checklist

## Required Files

1. **CLAUDE.md** — Project guide (auto-loaded by Claude Code)
2. **.mcp.json** — MCP server config (minimum: context7)
3. **.claude/agents/\*.md** — Project-specific agents (optional; User/Plugin agents usually sufficient)

## Setup Checklist

- [ ] `CLAUDE.md` created with project overview, stack, rules
- [ ] `.mcp.json` configured (context7 minimum)
- [ ] MEMORY.md entry added (path: `C:\MAIBOT\MEMORY.md`)
- [ ] `memory/<project>.md` file created with project details
- [ ] Test: `claude -p --model sonnet "Analyze project structure"`

## Existing Projects Status

| Project   | CLAUDE.md | .mcp.json | Multi-agent tested |
| --------- | :-------: | :-------: | :----------------: |
| MAITOK    |    ✅     |    ✅     |    ✅ verified     |
| MAIBEAUTY |    ✅     |    ✅     |    not applied     |
| MAIOSS    |    ✅     |    ✅     |    not applied     |
| MAIBOT    |    ✅     |    ✅     |    not applied     |

## Authentication

Claude Max OAuth is shared between MAIBOT (OpenClaw) and Claude Code CLI.
Tokens are separate but same subscription — conflicts are rare.
