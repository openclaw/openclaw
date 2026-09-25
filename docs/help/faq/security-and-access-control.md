---
summary: "Exposure, prompt injection, third-party skills, pairing, and how much autonomy to grant"
title: "Security and access control"
read_when:
  - You are exposing OpenClaw to inbound messages
  - You are judging plugin, skill, or autonomy risk
---

## Security and access control

<AccordionGroup>
  <Accordion title="Is it safe to expose OpenClaw to inbound DMs?">
    Yes - on channels that default to **pairing** (most DM-capable channels), a stranger who DMs your bot never reaches the model:

    - With the pairing default, unknown senders receive a pairing code and their message is not processed. Approve with `openclaw pairing approve --channel <channel> [--account <id>] <code>`. Pending requests are capped at **3 per channel**; check `openclaw pairing list --channel <channel> [--account <id>]` if a code did not arrive.
    - Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).

    A few workspace channels ship different defaults - ClickClack, for example, allows workspace members by default. Check your channel's page, and run `openclaw doctor` to confirm your DM policies look the way you expect.

  </Accordion>

  <Accordion title="Is prompt injection only a concern for public bots?">
    No. Prompt injection is about **untrusted content**, not just who can DM the bot. If your assistant reads external content (web search/fetch, browser pages, emails, docs, attachments, pasted logs), that content can carry instructions that try to hijack the model - even if you are the only sender.

    The biggest risk is when tools are enabled: the model can be tricked into exfiltrating context or calling tools on your behalf. Reduce the blast radius:

    - use a read-only or tool-disabled "reader" agent to summarize untrusted content
    - keep `web_search` / `web_fetch` / `browser` off for tool-enabled agents
    - treat decoded file/document text as untrusted too: OpenResponses `input_file` and media-attachment extraction both wrap extracted text in explicit external-content boundary markers instead of passing raw file text
    - sandbox and use strict tool allowlists

    Details: [Security](/gateway/security).

  </Accordion>

  <Accordion title="Is OpenClaw less safe because it uses TypeScript/Node instead of Rust/WASM?">
    Language and runtime matter, but are not the main risk for a personal agent. The practical risks are gateway exposure, who can message the bot, prompt injection, tool scope, credential handling, browser access, exec access, and third-party skill/plugin trust.

    Rust and WASM can provide stronger isolation for some code classes, but do not solve prompt injection, bad allowlists, public gateway exposure, overbroad tools, or a browser profile already logged in to sensitive accounts. Treat these as the primary controls: keep the Gateway private or authenticated, use pairing and allowlists for DMs/groups, deny or sandbox risky tools for untrusted inputs, install only trusted plugins and skills, and run `openclaw security audit --deep` after config changes.

    Details: [Security](/gateway/security), [Sandboxing](/gateway/sandboxing).

  </Accordion>

  <Accordion title="I saw reports about exposed OpenClaw instances. What should I check?">
    ```bash
    openclaw security audit --deep
    openclaw gateway status
    ```

    A safer baseline: Gateway bound to `loopback`, or exposed only through authenticated private access (tailnet, SSH tunnel, token/password auth, or a correctly configured trusted proxy); DMs in `pairing` or `allowlist` mode; group access limited to rooms you chose (group allowlists), with mention gating or sender allowlists where membership is broad or public; high-risk tools (`exec`, `browser`, `gateway`, `cron`) denied or tightly scoped for agents that read untrusted content; sandboxing enabled where tool execution needs a smaller blast radius.

    Public binds without auth, open DMs/groups with tools, and exposed browser control are the findings to fix first. Details: [openclaw security audit](/gateway/security/running-the-audit#openclaw-security-audit).

  </Accordion>

  <Accordion title="Are ClawHub skills and third-party plugins safe to install?">
    Treat third-party skills and plugins as code you are choosing to trust. ClawHub skill pages expose scan state before install, but scans are not a complete security boundary. OpenClaw does not run built-in local dangerous-code blocking during plugin/skill install or update; use operator-owned `security.installPolicy` for local allow/warn/block decisions.

    Safer pattern: prefer trusted authors and pinned versions, read the skill/plugin before enabling it, keep plugin/skill allowlists narrow, run untrusted-input workflows in a sandbox with minimal tools, and avoid giving third-party code broad filesystem, exec, browser, or secret access.

    Details: [Skills](/tools/skills), [Plugins](/tools/plugin), [Security](/gateway/security).

  </Accordion>

  <Accordion title="Should my bot have its own email, GitHub account, or phone number?">
    Yes, for most setups. Isolating the bot with separate accounts and phone numbers reduces the blast radius if something goes wrong, and makes it easier to rotate credentials or revoke access without impacting your personal accounts.

    Start small: give access only to the tools and accounts you actually need, and expand later if required.

    Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

  </Accordion>

  <Accordion title="Can I give it autonomy over my text messages and is that safe?">
    We do **not** recommend full autonomy over your personal messages. Safest pattern: keep DMs in **pairing mode** or a tight allowlist, use a **separate number or account** if it should message on your behalf, and let it draft while you **approve before sending**.

    To experiment, do it on a dedicated, isolated account. See [Security](/gateway/security).

  </Accordion>

  <Accordion title="Can I use cheaper models for personal assistant tasks?">
    Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are more susceptible to instruction hijacking, so avoid them for tool-enabled agents or when reading untrusted content. If you must use a smaller model, lock down tools and run inside a sandbox. See [Security](/gateway/security).
  </Accordion>

  <Accordion title="I ran /start in Telegram but did not get a pairing code">
    Pairing codes are sent **only** when an unknown sender messages the bot and `dmPolicy: "pairing"` is enabled; `/start` by itself does not generate a code.

    Check pending requests:

    ```bash
    openclaw pairing list telegram
    ```

    For immediate access, allowlist your sender id or set `dmPolicy: "open"` for that account.

  </Accordion>

  <Accordion title="WhatsApp: will it message my contacts? How does pairing work?">
    No. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code; their message is **not processed**. OpenClaw only replies to chats it receives or to explicit sends you trigger.

    ```bash
    openclaw pairing approve whatsapp <code>
    openclaw pairing list whatsapp
    ```

    The wizard's phone number prompt sets your **allowlist/owner** so your own DMs are permitted - it is not used for auto-sending. On your personal WhatsApp number, use that number and enable `channels.whatsapp.selfChatMode`.

  </Accordion>
</AccordionGroup>
