---
summary: "CLI onboarding wizard: guided setup for gateway, workspace, channels, and skills"
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Wizard (CLI)"
---

# Onboarding Wizard (CLI)

The CLI onboarding wizard is the recommended setup path for OpenClaw on macOS,
Linux, and Windows (via WSL2). It configures a local gateway or a remote
gateway connection, plus workspace defaults, channels, and skills.

```bash
openclaw onboard
```

<Info>
Fastest first chat: open the Control UI (no channel setup needed). Run
`openclaw dashboard` and chat in the browser. Docs: [Dashboard](/web/dashboard).
</Info>

## QuickStart vs Advanced

The wizard starts with **QuickStart** (defaults) vs **Advanced** (full control).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Local gateway on loopback
    - Existing workspace or default workspace
    - Gateway port `18789`
    - Gateway auth token auto-generated (even on loopback)
    - Tailscale exposure off
    - Telegram and WhatsApp DMs default to allowlist (you may be prompted for your phone number)
  </Tab>
  <Tab title="Advanced (full control)">
    - Exposes full prompt flow for mode, workspace, gateway, channels, daemon, and skills
  </Tab>
</Tabs>

## CLI onboarding details

<Columns>
  <Card title="CLI reference" href="/start/wizard-cli-reference">
    Full local and remote flow, auth and model matrix, config outputs, wizard RPC, and signal-cli behavior.
  </Card>
  <Card title="Automation and scripts" href="/start/wizard-cli-automation">
    Non-interactive onboarding recipes and automated `agents add` examples.
  </Card>
</Columns>

## Common follow-up commands

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive`.
</Note>

<Tip>
Recommended: set up a Brave Search API key so the agent can use `web_search`
(`web_fetch` works without a key). Easiest path: `openclaw configure --section web`
which stores `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## Related docs

- CLI command reference: [`openclaw onboard`](/cli/onboard)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)
