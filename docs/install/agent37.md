---
summary: "Host OpenClaw on Agent37 managed hosting"
read_when:
  - Setting up OpenClaw on Agent37
  - Looking for managed OpenClaw hosting with a browser dashboard
  - You want a hosted Gateway without administering a VPS
title: "Agent37"
---

Run a persistent OpenClaw Gateway on [Agent37](https://www.agent37.com/) managed
hosting. Agent37 provisions and operates the instance for you: each instance runs in
an isolated container with a browser dashboard, so there is no server setup or VPS
administration.

## Prerequisites

- Agent37 account ([signup](https://www.agent37.com/))
- A model API key (bring your own key from Anthropic, OpenAI, or another provider;
  some plans bundle models)
- About 5 minutes

## Deploy

<Steps>
  <Step title="Choose a plan">
    From [agent37.com](https://www.agent37.com/), pick a managed hosting plan and
    complete checkout. See the Agent37 site for current plans.
  </Step>

  <Step title="Launch the agent">
    In the [Agent37 dashboard](https://www.agent37.com/dashboard), click
    **Launch Agent**. Provisioning takes about a minute; the instance appears in
    your dashboard when it is ready.
  </Step>

  <Step title="Add your model key">
    Provide your model API key during setup (or use bundled models if your plan
    includes them). Keys are used by your instance directly against the model
    provider.
  </Step>
</Steps>

## Manage the instance

From the instance view in the dashboard:

- **Web Chat** -- open the hosted chat UI and talk to your agent.
- **Terminal** -- full TTY shell access to the instance: inspect logs, run
  `openclaw` CLI commands, or make manual changes.
- **Files** -- visual file browser for the instance workspace.
- Scheduled jobs and a live Linux desktop are also available from the dashboard.

Runtime updates and security patches are applied by Agent37 automatically.

## Verify your setup

Open **Web Chat** and send "Hi". OpenClaw replies and walks you through initial
preferences. From there, connect channels and configure the Gateway the same way
as any other OpenClaw install; see [Getting Started](/start/getting-started).

## Troubleshooting

**Instance stuck provisioning** -- provisioning normally completes in about a
minute; if it takes much longer, refresh the dashboard, then contact Agent37
support from the dashboard.

**Agent not replying in Web Chat** -- open **Terminal** and check the Gateway
logs, and confirm your model API key is valid for the configured provider.

## Next steps

- [Channels](/channels) -- connect Telegram, WhatsApp, Discord, and more
- [Gateway configuration](/gateway/configuration) -- all config options

## Related

- [Install overview](/install)
- [VPS hosting](/vps)
- [Hostinger](/install/hostinger)
