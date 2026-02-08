# Contributing to OpenClaw

Welcome to the lobster tank! 🦞

## Quick Links

- **GitHub:** https://github.com/openclaw/openclaw
- **Discord:** https://discord.gg/qkhbAGHRBT
- **X/Twitter:** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)

## Maintainers

- **Peter Steinberger** - Benevolent Dictator
  - GitHub: [@steipete](https://github.com/steipete) · X: [@steipete](https://x.com/steipete)

- **Shadow** - Discord + Slack subsystem
  - GitHub: [@thewilloftheshadow](https://github.com/thewilloftheshadow) · X: [@4shad0wed](https://x.com/4shad0wed)

- **Jos** - Telegram, API, Nix mode
  - GitHub: [@joshp123](https://github.com/joshp123) · X: [@jjpcodes](https://x.com/jjpcodes)

- **Christoph Nakazawa** - JS Infra
  - GitHub: [@cpojer](https://github.com/cpojer) · X: [@cnakazawa](https://x.com/cnakazawa)

- **Gustavo Madeira Santana** - Multi-agents, CLI, web UI
  - GitHub: [@gumadeiras](https://github.com/gumadeiras) · X: [@gumadeiras](https://x.com/gumadeiras)

- **Maximilian Nussbaumer** - DevOps, CI/CD
  - GitHub: [@quotentiroler](https://github.com/quotentiroler)

## How to Contribute

1. **Bugs & small fixes** → Open a PR!
2. **New features / architecture** → Start a [GitHub Discussion](https://github.com/openclaw/openclaw/discussions) or ask in Discord first
3. **Questions** → Discord #setup-help

## Before You PR

- Test locally with your OpenClaw instance
- Run tests: `pnpm build && pnpm check && pnpm test`
- Keep PRs focused (one thing per PR)
- Describe what & why

## Control UI Decorators

The Control UI uses Lit with **legacy** decorators (current Rollup parsing does not support
`accessor` fields required for standard decorators). When adding reactive fields, keep the
legacy style:

```ts
@state() foo = "bar";
@property({ type: Number }) count = 0;
```

The root `tsconfig.json` is configured for legacy decorators (`experimentalDecorators: true`)
with `useDefineForClassFields: false`. Avoid flipping these unless you are also updating the UI
build tooling to support standard decorators.

## AI/Vibe-Coded PRs Welcome! 🤖

Built with Codex, Claude, or other AI tools? **Awesome - just mark it!**

Please include in your PR:

- [ ] Mark as AI-assisted in the PR title or description
- [ ] Note the degree of testing (untested / lightly tested / fully tested)
- [ ] Include prompts or session logs if possible (super helpful!)
- [ ] Confirm you understand what the code does

AI PRs are first-class citizens here. We just want transparency so reviewers know what to look for.

## Current Focus & Roadmap 🗺

We are currently prioritizing:

- **Stability**: Fixing edge cases in channel connections (WhatsApp/Telegram).
- **UX**: Improving the onboarding wizard and error messages.
- **Skills**: Expanding the library of bundled skills and improving the Skill Creation developer experience.
- **Performance**: Optimizing token usage and compaction logic.

Check the [GitHub Issues](https://github.com/openclaw/openclaw/issues) for "good first issue" labels!

## Core vs ClawHub

Not everything belongs in the main repo. Here's how to decide:

| Belongs in **Core**                            | Belongs on **[ClawHub](https://clawhub.ai)**         |
| ---------------------------------------------- | ---------------------------------------------------- |
| Channel integrations (Telegram, Discord, etc.) | Domain-specific skills (QR codes, image tools, etc.) |
| CLI commands and infrastructure                | Custom workflows and automations                     |
| Provider integrations (LLM backends)           | Niche or experimental utilities                      |
| Security, routing, and core plumbing           | Third-party service integrations                     |

**Rule of thumb:** if it adds new dependencies or is useful to some users but not most, it belongs on ClawHub. When in doubt, ask in Discord or open a Discussion before writing code.

Skills submitted as PRs to this repo will be redirected to ClawHub. If the core maintainers later decide certain functionality should be first-party, it will be integrated into core.

## Branch Strategy

> **Note:** The staged promotion pipeline is not yet active. Workflows are in
> place but dormant. For now, open PRs targeting `main` as usual. Once the
> pipeline is activated, the flow below will apply.

We will use staged branch promotion to keep `main` stable:

```
dev/* / feature/* / fix/*  →  develop  →  alpha  →  beta  →  main
```

### For External Contributors (once pipeline is active)

1. Fork the repo
2. Create your branch (`dev/my-feature`, `fix/some-bug`, etc.)
3. Open a PR targeting `develop` (not `main`)
4. CI runs lightweight checks only — no heavy platform tests on your PR
5. Once merged to `develop`, your changes promote through alpha → beta → main automatically

### For Maintainers (once pipeline is active)

- **Regular changes**: merge to `develop`, let the pipeline promote
- **Hotfixes**: use `hotfix/*` branches for emergency fixes that bypass staging directly to `main`
- **Docs-only changes**: skip the test pipeline automatically (paths-ignore)

See [Pipeline docs](https://docs.openclaw.ai/reference/pipeline) for full details.
