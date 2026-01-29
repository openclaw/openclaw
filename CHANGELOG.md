# DNA Changelog

All notable changes to DNA are documented here.

## [1.0.0] - 2026-01-29

### 🎉 Initial Release

DNA is forked from [Moltbot/Clawdbot](https://github.com/moltbot/moltbot) and enhanced with additional features.

### Added

#### Core Platform (from Moltbot)
- Multi-channel messaging support (WhatsApp, Telegram, Discord, Slack, Signal, iMessage)
- AI provider integrations (Anthropic, OpenAI, Google, OpenRouter, Ollama)
- Persistent memory system with daily notes and long-term storage
- 60+ built-in skills for common tasks
- Session management and sub-agent spawning
- Cron scheduling for automated tasks
- Web search and fetch capabilities
- Browser automation
- Secure API key storage in system keychain

#### DNA IDE (`extensions/ide/`)
- Full-featured browser-based code editor
- Monaco editor with IntelliSense
- AI chat panel with project context
- Inline code editing (Cmd+K) with diff preview
- Agent mode for autonomous multi-file changes
- Integrated terminal with multiple tabs and splits
- Git integration (stage, commit, push, pull, branch)
- Built-in browser preview with DevTools
- Debugger with breakpoints and variable inspection
- Semantic code search with embeddings
- Custom keybindings and themes
- Project dashboard with file stats and TODOs
- Memory panel integration

#### Custom Skills
- `dna-expert` — Self-help for DNA configuration and troubleshooting
- `dna-architect` — Extension system architecture guidance
- `dna-logs` — Log analysis and diagnostics
- `dna-skill-update` — Backup and update workflow
- `clawddocs` — Documentation search and caching
- `helium-10` — Amazon seller research automation
- `prd-reconciliation` — PRD vs code verification
- `product-dev` — Product development workflow
- `auto-updater` — Automatic updates via cron
- `skills-search` — Search skills.sh registry
- `skill-audit` — Security audit for skills

#### BugDNA Knowledge System (`knowledge/`)
- Automatic bug capture and indexing
- Pattern recognition for recurring issues
- Proactive warnings before risky actions
- Learning from user decisions
- Bug templates and workflows

#### Workspace Templates (`workspace-template/`)
- `AGENTS.md` — Agent behavior configuration
- `SOUL.md` — AI personality customization
- `USER.md` — User profile template
- `MEMORY.md` — Long-term memory template
- `HEARTBEAT.md` — Proactive check configuration
- `TOOLS.md` — Tool-specific notes

#### Documentation (`docs/`)
- Quick start guide (5-minute setup)
- Full installation guide
- Configuration reference
- Skills development guide
- Troubleshooting guide
- Comprehensive FAQ (20+ questions)

#### Branding Package (`branding/`)
- Brand guide with logo concepts and color palette
- Video script for 2-minute product demo
- Landing page specification
- ElevenLabs voice setup for natural AI narration

#### Developer Tools
- `scripts/sync-from-workspace.sh` — Sync enhancements from development workspace
- PRD template for detailed product specifications

### Changed

- Renamed all `moltbot`/`clawdbot` references to `dna`
- CLI command: `dna` (instead of `clawdbot`/`moltbot`)
- Config location: `~/.dna/dna.json`
- Updated package.json with DNA branding

### Technical Details

- **Based on:** Moltbot v2026.1.29
- **License:** MIT
- **Node.js:** 18+ required
- **Platforms:** macOS, Linux, Windows (WSL2)

---

## Version History

| Version | Date | Description |
|---------|------|-------------|
| 1.0.0 | 2026-01-29 | Initial release with IDE and enhanced skills |

---

## Upgrade Guide

### From Clawdbot/Moltbot

1. DNA is a separate installation (doesn't replace Clawdbot)
2. You can run both simultaneously on different ports
3. Skills and memory files are compatible
4. API keys can be shared

```bash
# Clone DNA
git clone https://github.com/vanek-nutic/dna.git
cd dna
npm install && npm run build

# Run wizard (will create new config)
./dna.mjs wizard
```
