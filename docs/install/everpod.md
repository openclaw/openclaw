---
summary: "Run OpenClaw on Everpod, a managed private cloud computer for your agent"
read_when:
  - Setting up OpenClaw on Everpod
  - You want managed OpenClaw hosting with no server to administer
  - You want your agent on a private machine of its own
title: "Everpod"
---

Run OpenClaw on [Everpod](https://everpod.ai), a managed host that gives your agent a private, always-on cloud computer of its own. Everpod sets OpenClaw up, secures it, backs it up, and keeps it updated. You talk to your agent through a messaging app and manage it in the [Control UI](/web/control-ui). There is no server to administer.

## What you need

- An email address
- A card, Apple Pay, or Google Pay
- About 15 minutes for the pod to be set up

Model usage is included in every plan, so you don't need an API key to start. You can add your own provider key at any time.

## Set up

<Steps>
  <Step title="Create your agent">
    1. Go to [everpod.ai/create](https://everpod.ai/create) and name your agent.
    2. Enter your email address, then the six-digit code Everpod sends you. This creates your account.
    3. Review the plan, then select the button that starts your agent's pod and complete checkout.

  </Step>

  <Step title="Wait for setup">
    Everpod sets up the pod: a private cloud computer with OpenClaw installed and secured. This usually takes about 15 minutes. You can leave the page; Everpod emails you when your agent is awake.

  </Step>

  <Step title="Connect a messaging app">
    On the pod page, choose **Telegram** and follow the guided steps:

    - Create a bot with [BotFather](https://t.me/BotFather) and paste its token.
    - Select **Confirm it's you on Telegram**, so your agent knows you are its owner. You don't need to approve a pairing code.

    For Discord, Slack, WhatsApp, or another channel, choose **Discord, Slack, WhatsApp & more** instead. It opens your agent's chat in the Control UI, where you ask your agent to connect the app with you. See [Channels](/channels) for what each channel needs.

  </Step>

  <Step title="Open the Control UI">
    On the pod page, select **Open the OpenClaw control panel**. It opens signed in: there is no Gateway token to copy and no device to approve. Models, skills, schedules, channels, and the rest of OpenClaw's settings are managed there.

  </Step>
</Steps>

## Verify your setup

At the end of the Telegram steps, select **Open Telegram and say hello**, or message your bot yourself. Your agent replies on Telegram.

## What Everpod manages

- **One customer per machine.** Each pod is a private cloud computer for one agent. Nothing on it is shared with other customers.
- **No incoming connections, unless you switch on a public address.** You reach the Control UI by signing in to Everpod with your email. When a task needs one, the **Public address** switch in the pod's **Settings** gives your agent a fixed web address that services and automations can call, and puts any web app your agent builds online. The Control UI is never reachable through it.
- **Models.** The included usage works from the first minute. Change the model or reasoning effort on the Control UI's **Models** page, or add your own provider key there; on your own key, Everpod adds nothing on top. Each plan's included usage is capped, and when it runs out, your agent waits for the plan to renew unless you move to a bigger plan or add your own key.
- **Updates.** Everpod keeps OpenClaw on versions it has tested and updates the pod for you. An update keeps everything your agent has: its files, memory, installed tools, and accounts.
- **Backups.** Backups are made daily and rotate over roughly 7 days.
- **A terminal when you want one.** In the pod's **Settings**, **Open the terminal** gives you a command line on the pod, in the Control UI.
- **Cancellation.** Cancel from the pod's **Settings**. The pod runs to the end of the paid period, then stops, and 7 days later it is permanently deleted, backups included. Before then, email [support@everpod.ai](mailto:support@everpod.ai) for a full copy of your pod's data.

## Getting help

Email [support@everpod.ai](mailto:support@everpod.ai).

## Next steps

- [Channels](/channels) -- connect Telegram, WhatsApp, Discord, and more
- [Control UI](/web/control-ui) -- what you can do in the browser
- [Model providers](/concepts/model-providers) -- the providers you can add your own key for

## Related

- [Install overview](/install)
- [VPS hosting](/vps)
