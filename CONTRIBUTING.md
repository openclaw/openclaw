# Contributing to SotyBot

Thank you for your interest in contributing to SotyBot! 🤖

## Ways to Contribute

### 1. Build Agents 🤖
The easiest way to contribute is to build agents for new domains:
- Security agents (malware analysis, threat detection)
- Crypto agents (trading, DeFi research)
- Creative agents (content generation, design)
- Sports agents (predictions, analysis)
- Any domain you can imagine!

- **GitHub:** https://github.com/openclaw/openclaw
- **Vision:** [`VISION.md`](VISION.md)
- **Discord:** https://discord.gg/qkhbAGHRBT
- **X/Twitter:** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)

See [Agent Development Guide](docs/AGENT_DEV.md) for details.

### 2. Improve Core Engine 🔧
- Add new action connectors
- Enhance permission system
- Improve performance
- Add tests

### 3. Documentation 📚
- Improve README and guides
- Add examples and tutorials
- Translate documentation
- Create video tutorials

## Core Maintainers
- **Shadow** - Discord subsystem, Discord admin, Clawhub, all community moderation
  - GitHub: [@thewilloftheshadow](https://github.com/thewilloftheshadow) · X: [@4shadowed](https://x.com/4shadowed)

- **Vignesh** - Memory (QMD), formal modeling, TUI, IRC, and Lobster
  - GitHub: [@vignesh07](https://github.com/vignesh07) · X: [@\_vgnsh](https://x.com/_vgnsh)

### 4. Report Bugs 🐛
- Open issues with detailed descriptions
- Include reproduction steps
- Provide system information

## Development Setup

```bash
# Clone the repo
git clone https://github.com/sotyhub/sotybot.git
cd sotybot

- **Ayaan Zaidi** - Telegram subsystem, iOS app
  - GitHub: [@obviyus](https://github.com/obviyus) · X: [@0bviyus](https://x.com/0bviyus)

- **Tyler Yust** - Agents/subagents, cron, BlueBubbles, macOS app
  - GitHub: [@tyler6204](https://github.com/tyler6204) · X: [@tyleryust](https://x.com/tyleryust)

- **Mariano Belinky** - iOS app, Security
  - GitHub: [@mbelinky](https://github.com/mbelinky) · X: [@belimad](https://x.com/belimad)

- **Nimrod Gutman** - iOS app, macOS app and crustacean features
  - GitHub: [@ngutman](https://github.com/ngutman) · X: [@theguti](https://x.com/theguti)

- **Vincent Koc** - Agents, Telemetry, Hooks, Security
  - GitHub: [@vincentkoc](https://github.com/vincentkoc) · X: [@vincent_koc](https://x.com/vincent_koc)

- **Val Alexander** - UI/UX, Docs, and Agent DevX
  - GitHub: [@BunsDev](https://github.com/BunsDev) · X: [@BunsDev](https://x.com/BunsDev)

- **Seb Slight** - Docs, Agent Reliability, Runtime Hardening
  - GitHub: [@sebslight](https://github.com/sebslight) · X: [@sebslig](https://x.com/sebslig)

- **Christoph Nakazawa** - JS Infra
  - GitHub: [@cpojer](https://github.com/cpojer) · X: [@cnakazawa](https://x.com/cnakazawa)

- **Gustavo Madeira Santana** - Multi-agents, CLI, web UI
  - GitHub: [@gumadeiras](https://github.com/gumadeiras) · X: [@gumadeiras](https://x.com/gumadeiras)

- **Onur Solmaz** - Agents, dev workflows, ACP integrations, MS Teams
  - GitHub: [@onutc](https://github.com/onutc), [@osolmaz](https://github.com/osolmaz) · X: [@onusoz](https://x.com/onusoz)

- **Josh Avant** - Core, CLI, Gateway, Security, Agents
  - GitHub: [@joshavant](https://github.com/joshavant) · X: [@joshavant](https://x.com/joshavant)

- **Jonathan Taylor** - ACP subsystem, Gateway features/bugs, Gog/Mog/Sog CLI's, SEDMAT
  - Github [@visionik](https://github.com/visionik) · X: [@visionik](https://x.com/visionik)
- **Josh Lehman** - Compaction, Tlon/Urbit subsystem
  - Github [@jalehman](https://github.com/jalehman) · X: [@jlehman\_](https://x.com/jlehman_)

## How to Contribute

1. **Bugs & small fixes** → Open a PR!
2. **New features / architecture** → Start a [GitHub Discussion](https://github.com/openclaw/openclaw/discussions) or ask in Discord first
3. **Questions** → Discord [#help](https://discord.com/channels/1456350064065904867/1459642797895319552) / [#users-helping-users](https://discord.com/channels/1456350064065904867/1459007081603403828)

# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/

- Keep PRs focused (one thing per PR; do not mix unrelated concerns)
- Describe what & why
- **Include screenshots** — one showing the problem/before, one showing the fix/after (for UI or visual changes)

# Run linters
black .
ruff check .
mypy .
```

## Pull Request Process

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feature/your-feature`
3. **Make changes** and commit: `git commit -m "Add amazing feature"`
4. **Run tests**: `pytest tests/`
5. **Push**: `git push origin feature/your-feature`
6. **Open a Pull Request**

## Code Style

- Follow PEP 8
- Use type hints
- Write docstrings
- Add tests for new features
- Keep lines under 100 characters

## Agent Contribution Guidelines

When contributing an agent:

1. **Create proper structure**:
   ```
   agents/[domain]/[agent_name]/
   ├── manifest.json
   ├── agent.py
   └── README.md (optional)
   ```

2. **Include complete manifest**:
   - Name, version, author
   - Domain and capabilities
   - Required actions
   - Risk level
   - Configuration schema

3. **Implement BaseAgent**:
   - All required methods
   - Proper error handling
   - Execution tracking

4. **Add documentation**:
   - What the agent does
   - Example usage
   - Configuration options

5. **Test your agent**:
   - Load and unload
   - Execute various tasks
   - Handle errors gracefully

## Community Guidelines

- Be respectful and inclusive
- Help others learn
- Share knowledge
- Give credit where due
- Focus on building together

## Questions?

- Open a GitHub issue
- Join our [Discord](https://discord.gg/sotyhub)
- Email: hello@sotyhub.com

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.

---

**Thank you for helping build the open agent ecosystem! 🚀**

## Contributors to original OpenClaw framework

- **Stability**: Fixing edge cases in channel connections (WhatsApp/Telegram).
- **UX**: Improving the onboarding wizard and error messages.
- **Skills**: For skill contributions, head to [ClawHub](https://clawhub.ai/) — the community hub for OpenClaw skills.
- **Performance**: Optimizing token usage and compaction logic.

Check the [GitHub Issues](https://github.com/openclaw/openclaw/issues) for "good first issue" labels!

## Maintainers

We're selectively expanding the maintainer team.
If you're an experienced contributor who wants to help shape the platform's direction — whether through code, docs, or community — we'd like to hear from you.

Being a maintainer is a responsibility, not an honorary title. We expect active, consistent involvement — triaging issues, reviewing PRs, and helping move the project forward.

Still interested? Email contributing@openclaw.ai with:

- Links to your PRs on OpenClaw (if you don't have any, start there first)
- Links to open source projects you maintain or actively contribute to
- Your GitHub, Discord, and X/Twitter handles
- A brief intro: background, experience, and areas of interest
- Languages you speak and where you're based
- How much time you can realistically commit

We welcome people across all skill sets — engineering, documentation, community management, and more.
We review every human-only-written application carefully and add maintainers slowly and deliberately.
Please allow a few weeks for a response.

## Report a Vulnerability

We take security reports seriously. Report vulnerabilities directly to the repository where the issue lives:

- **Core CLI and gateway** — [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **macOS desktop app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/macos)
- **iOS app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/ios)
- **Android app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/android)
- **ClawHub** — [openclaw/clawhub](https://github.com/openclaw/clawhub)
- **Trust and threat model** — [openclaw/trust](https://github.com/openclaw/trust)

For issues that don't fit a specific repo, or if you're unsure, email **security@openclaw.ai** and we'll route it.

### Required in Reports

1. **Title**
2. **Severity Assessment**
3. **Impact**
4. **Affected Component**
5. **Technical Reproduction**
6. **Demonstrated Impact**
7. **Environment**
8. **Remediation Advice**

Reports without reproduction steps, demonstrated impact, and remediation advice will be deprioritized. Given the volume of AI-generated scanner findings, we must ensure we're receiving vetted reports from researchers who understand the issues.
