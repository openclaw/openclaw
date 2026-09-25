---
summary: "What OpenClaw is, who it is for, how it is funded, and how it compares"
title: "What is OpenClaw?"
read_when:
  - You are evaluating OpenClaw or explaining it to someone
  - You want the ownership, funding, or comparison answers
---

## What is OpenClaw?

<AccordionGroup>
  <Accordion title="What is OpenClaw, in one paragraph?">
    OpenClaw is an AI assistant you run on your own infrastructure - for yourself, or shared with your team. It replies on the messaging surfaces you already use (Discord, Google Chat, iMessage, Mattermost, Signal, Slack, Telegram, WebChat, WhatsApp, and bundled channel plugins such as QQ Bot) and can also do voice plus hosted widgets in chat, on session dashboards, and in the macOS panel. The **Gateway** is the always-on control plane; the assistant is the product. The same gateway scales from one person's WhatsApp to a shared workspace bot with [multi-user sessions](/concepts/multi-user).
  </Accordion>

  <Accordion title="Can my team share one OpenClaw?">
    Yes. A shared gateway is a supported, first-class deployment: sessions carry an immutable creator, an assignable owner, and the people who prompted them; the Control UI shows who is viewing and typing in real time; and commits from shared sessions can carry `Co-authored-by` trailers for the people who steered them. [Named operator roles](/gateway/operator-scopes#named-operator-roles) bound what each teammate can do.

    One boundary to respect: a gateway is one trust domain. Share it with people who trust each other; mutually adversarial users need separate gateways. See [Team setup](/start/teams), [Multi-user mode](/concepts/multi-user), and [Security](/gateway/security).

  </Accordion>

  <Accordion title="Value proposition">
    OpenClaw is not "just a Claude wrapper." It is a **local-first control plane** that runs a capable assistant on **your own hardware**, reachable from the chat apps you already use, with stateful sessions, memory, and tools - without handing your workflows to a hosted SaaS.

    - **Your devices, your data**: run the Gateway wherever you want (Mac, Linux, VPS) and keep the workspace and session history local.
    - **Real channels, not a web sandbox**: Discord/iMessage/Signal/Slack/Telegram/WhatsApp/etc, plus mobile voice and hosted widgets.
    - **Model-agnostic**: use Anthropic, MiniMax, OpenAI, OpenRouter, etc., with per-agent routing and failover.
    - **Local-only option**: run local models so all data can stay on your device.
    - **Multi-agent routing**: separate agents per channel, account, or task, each with its own workspace and defaults.
    - **Open source and hackable**: inspect, extend, and self-host without vendor lock-in.

    Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent), [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="I just set it up - what should I do first?">
    Good first projects: build a website (WordPress, Shopify, or a static site); prototype a mobile app (outline, screens, API plan); organize files and folders; connect Gmail and automate summaries or follow-ups.

    It can handle large tasks, but works best split into phases with sub-agents for parallel work.

  </Accordion>

  <Accordion title="What are the top five everyday use cases for OpenClaw?">
    - **Personal briefings**: summaries of inbox, calendar, and news you care about.
    - **Research and drafting**: quick research, summaries, and first drafts for emails or docs.
    - **Reminders and follow-ups**: cron- or heartbeat-driven nudges and checklists.
    - **Browser automation**: filling forms, collecting data, repeating web tasks.
    - **Cross-device coordination**: send a task from your phone, let the Gateway run it on a server, get the result back in chat.

  </Accordion>

  <Accordion title="Can OpenClaw help with lead gen, outreach, ads, and blogs for a SaaS?">
    Yes, for **research, qualification, and drafting**: scanning sites, building shortlists, summarizing prospects, writing outreach or ad copy drafts.

    For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and platform policies, and review anything before it sends. Let OpenClaw draft; you approve.

    Docs: [Security](/gateway/security).

  </Accordion>

  <Accordion title="Is OpenClaw owned by OpenAI?">
    No. OpenClaw is stewarded by the [OpenClaw Foundation](https://openclaw.org), an independent 501(c)(3). OpenAI is one of several donors, and its creator works there. Donors do not own, control, or direct the project. Codex is one [agent harness](/concepts/agent-runtimes) plugin among several, and no lab's model is privileged in the code.

  </Accordion>

  <Accordion title="What does OpenClaw send to the Foundation?">
    By default, a daily update check carrying the OpenClaw version, OS, Node version, and CPU architecture: the same information any package registry sees. Optional anonymous feature statistics are off by default and carry no identifier. No prompts, messages, model names, keys, paths, or machine identifiers are ever sent to the Foundation. Set `update.checkOnStart: false` to send nothing at all. Traffic to the model providers and chat platforms you configure is separate and goes to them, as always; see [Is all data used with OpenClaw saved locally?](/help/faq/where-things-live-on-disk#is-all-data-used-with-openclaw-saved-locally). Details: [Usage telemetry and update checks](/gateway/telemetry).

  </Accordion>

  <Accordion title="How is OpenClaw funded, and how does that compare?">
    The Foundation is funded by donations and has no product to sell: no paid tier, no hosted service, no token. It is not venture-backed. Some other self-hosted agents are built by venture-funded companies that sell a subscription their agent offers during setup. That is a difference in incentives, not a judgment of their engineering; see the [governance comparison](/start/why-openclaw#governance).

  </Accordion>

  <Accordion title="What are the advantages vs Claude Code for web development?">
    OpenClaw is an **assistant and coordination layer**, not an IDE replacement. Use Claude Code or Codex for the fastest direct coding loop inside a repo. Use OpenClaw for durable memory, cross-device access, and tool orchestration.

    - Persistent memory and workspace across sessions.
    - Multi-platform access (Telegram, WhatsApp, TUI, WebChat).
    - Tool orchestration (browser, files, scheduling, hooks).
    - Always-on Gateway (run on a VPS, interact from anywhere).
    - Nodes for local browser/screen/camera/exec.

    Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase).

  </Accordion>
</AccordionGroup>
