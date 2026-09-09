---
summary: "FAQ: provider auth and limits, model choice, hardware, and where to run the Gateway"
read_when:
  - Choosing auth and provider subscriptions
  - Hitting provider rate limits or OAuth questions
  - Deciding on hardware, a VM, or a VPS for the Gateway
title: "FAQ: providers, hardware, and hosting"
sidebarTitle: "Providers and hosting"
---

Provider auth, model, hardware, and hosting Q&A. For install, onboarding, and
first-run failures see
[FAQ: quick start and first-run setup](/help/faq-first-run/quick-start).

<a id="why-am-i-seeing-http-429-ratelimiterror-from-anthropic"></a>

<AccordionGroup>
  <Accordion title="Why am I seeing HTTP 429 rate_limit_error from Anthropic?">
    Your **Anthropic quota/rate limit** is exhausted for the current window. On **Claude
    CLI**, wait for the window to reset or upgrade your plan. On an **Anthropic API key**,
    check usage/billing in the Anthropic Console and raise limits as needed.

    If the message is specifically `Extra usage is required for long context requests`,
    the request is trying to use Anthropic's 1M context window (a GA-capable 1M Claude 4.x
    model, or legacy `params.context1m: true` config), and your current credential is not
    eligible for long-context billing.

    Set a **fallback model** so OpenClaw keeps replying while a provider is rate-limited.
    See [Models](/cli/models), [OAuth](/concepts/oauth), and
    [Anthropic 429 extra usage required for long context](/gateway/troubleshooting#anthropic-429-extra-usage-required-for-long-context).

  </Accordion>

  <Accordion title="Is AWS Bedrock supported?">
    Yes. OpenClaw has a bundled **Amazon Bedrock (Converse)** provider. With AWS env
    markers present (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`),
    OpenClaw auto-enables the implicit Bedrock provider for model discovery; otherwise
    set `plugins.entries.amazon-bedrock.config.discovery.enabled: true` or add a manual
    provider entry. See [Amazon Bedrock](/providers/bedrock) and [Model providers](/providers/models).
    An OpenAI-compatible proxy in front of Bedrock is still a valid option if you prefer a managed key flow.
  </Accordion>

  <Accordion title="How does Codex auth work?">
    OpenClaw supports **OpenAI Codex** via OAuth (ChatGPT sign-in). A fresh
    setup with no primary model uses exact `openai/gpt-5.6-sol` for
    ChatGPT/Codex subscription auth plus native Codex app-server execution.
    Reauthentication preserves an existing explicit model, including
    `openai/gpt-5.5`. If the Codex workspace does not expose GPT-5.6, select
    `openai/gpt-5.5` explicitly; OpenClaw does not silently downgrade. Legacy
    Codex-prefixed model refs are legacy config repaired by `openclaw doctor
    --fix`. Direct OpenAI API-key access remains available for non-agent OpenAI
    API surfaces and, through an ordered `openai` API-key profile, for agent
    models too. See [Model providers](/concepts/model-providers) and
    [Onboarding (CLI)](/start/wizard).
  </Accordion>

  <Accordion title="Why does OpenClaw still mention legacy OpenAI Codex prefix?">
    `openai` is the current provider and auth-profile id for both OpenAI API keys and
    ChatGPT/Codex OAuth - OpenAI Codex is folded into it. You may still see a legacy
    `openai-codex` prefix in older config and migration warnings:

    - `openai/gpt-5.6-sol` = fresh ChatGPT/Codex subscription setup with the native Codex runtime for agent turns.
    - `openai/gpt-5.5` = explicit supported selection for existing config or accounts without GPT-5.6 access.
    - Legacy `openai-codex/*` model refs = legacy route repaired by `openclaw doctor --fix`.
    - `openai/gpt-5.5` plus an ordered `openai` API-key profile = API-key auth for an OpenAI agent model.
    - Legacy `openai-codex` auth profile ids = legacy ids migrated by `openclaw doctor --fix`.

    Want direct OpenAI Platform billing? Set `OPENAI_API_KEY`. Want ChatGPT/Codex
    subscription auth? Run `openclaw models auth login --provider openai`. Keep
    model refs under the canonical `openai/*` provider. Fresh subscription
    setup uses exact `openai/gpt-5.6-sol`; doctor repairs legacy Codex-prefixed
    refs without upgrading an explicit `openai/gpt-5.5` selection.

  </Accordion>

  <Accordion title="Why can Codex OAuth limits differ from ChatGPT web?">
    Codex OAuth uses OpenAI-managed, plan-dependent quota windows that can differ from the
    ChatGPT website/app experience, even on the same account.

    `openclaw models status` shows the currently visible provider usage/quota windows, but
    does not invent or normalize ChatGPT-web entitlements into direct API access. For the
    direct OpenAI Platform billing/limit path, use `openai/*` with an API key.

  </Accordion>

  <Accordion title="Do you support OpenAI subscription auth (Codex OAuth)?">
    Yes, fully. OpenAI explicitly allows subscription OAuth usage in external
    tools/workflows like OpenClaw. Onboarding can run the OAuth flow for you.

    See [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), and [Onboarding (CLI)](/start/wizard).

  </Accordion>

  <Accordion title="Can I use Gemini CLI or Antigravity OAuth?">
    OpenClaw does not offer new Gemini CLI OAuth or Antigravity OAuth setup.
    Connect Google with an AI Studio API key or Vertex AI instead.

    The optional `google-gemini-cli` runtime remains available for advanced
    setups using a supported Google API-key profile. Existing valid legacy
    Gemini CLI OAuth profiles remain executable for compatibility, but OpenClaw
    cannot create or repair them.

    Details: [Google](/providers/google), [Model providers](/concepts/model-providers).

  </Accordion>

  <Accordion title="Is a local model OK for casual chats?">
    Usually no. OpenClaw needs large context + strong safety; small cards truncate context
    and skip provider-side safety filters. If you must, run the **largest** model build you
    can locally (LM Studio) - see [Local models](/gateway/local-models). Smaller/quantized
    models raise prompt-injection risk - see [Security](/gateway/security).
  </Accordion>

  <Accordion title="How do I keep hosted model traffic in a specific region?">
    Pick region-pinned endpoints. OpenRouter exposes US-hosted options for MiniMax, Kimi,
    and GLM; choose the US-hosted variant to keep data in-region. You can still list
    Anthropic/OpenAI alongside these with `models.mode: "merge"` so fallbacks stay
    available while respecting the regioned provider you select.
  </Accordion>

  <Accordion title="Do I have to buy a Mac Mini to install this?">
    No. OpenClaw runs on macOS or Linux (Windows via WSL2). A Mac mini is a popular
    always-on host choice, but a small VPS, home server, or Raspberry Pi-class box works too.

    You only need a Mac **for macOS-only tools**. For iMessage, use [iMessage](/channels/imessage)
    with `imsg` on any Mac signed into Messages - if the Gateway runs on Linux or elsewhere,
    set `channels.imessage.cliPath` to an SSH wrapper that runs `imsg` on that Mac. For other
    macOS-only tools, run the Gateway on a Mac or pair a macOS node.

    Docs: [iMessage](/channels/imessage), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="Do I need a Mac mini for iMessage support?">
    You need **some macOS device** signed into Messages - not necessarily a Mac mini, any
    Mac works. Use [iMessage](/channels/imessage) with `imsg`; the Gateway can run on that
    Mac, or elsewhere with an SSH wrapper `cliPath`.

    Common setups:

    - Gateway on Linux/VPS, `channels.imessage.cliPath` set to an SSH wrapper that runs `imsg` on a Mac signed into Messages.
    - Everything on one Mac for the simplest single-machine setup.

    Docs: [iMessage](/channels/imessage), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="If I buy a Mac mini to run OpenClaw, can I connect it to my MacBook Pro?">
    Yes. The **Mac mini can run the Gateway**, and your MacBook Pro connects as a **node**
    (companion device). Nodes do not run the Gateway - they add capabilities like
    screen/camera and `system.run` on that device. A Mac node can also present
    hosted widgets in its native panel.

    Common pattern: Gateway on the always-on Mac mini; MacBook Pro runs the macOS app or a
    node host and pairs to the Gateway. Check with `openclaw nodes status` / `openclaw nodes list`.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

  </Accordion>

  <Accordion title="Can I use Bun?">
    Yes. Node remains the primary, default, and recommended runtime, but Bun 1.4+
    with WAL-reset-safe `node:sqlite` can run the CLI, Gateway, and managed node
    host as an explicit opt-in. Bun can also run package scripts; use
    `pnpm install` for dependency installation.
  </Accordion>

  <Accordion title="Telegram: what goes in allowFrom?">
    `channels.telegram.allowFrom` is the **human sender's Telegram user ID** (numeric),
    not the bot username. Setup asks for numeric user IDs only; `openclaw doctor --fix`
    can try to resolve legacy `@username` entries.

    Safer (no third-party bot): DM your bot, run `openclaw logs --follow`, read `from.id`.

    Official Bot API: DM your bot, call `https://api.telegram.org/bot<bot_token>/getUpdates`, read `message.from.id`.

    Third-party (less private): DM `@userinfobot` or `@getidsbot`.

    See [Telegram access control](/channels/telegram#access-control-and-activation).

  </Accordion>

  <Accordion title="Can multiple people use one WhatsApp number with different OpenClaw instances?">
    Yes, via **multi-agent routing**. Bind each sender's WhatsApp DM (`peer: { kind: "direct", id: "+15551234567" }`) to a different `agentId`, giving each person their own workspace and session store. Replies still come from the **same WhatsApp account**; DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).
  </Accordion>

  <Accordion title='Can I run a "fast chat" agent and an "Opus for coding" agent?'>
    Yes. Use multi-agent routing: give each agent its own default model, then bind inbound
    routes (provider account or specific peers) to each agent. Example config:
    [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and
    [Configuration](/gateway/configuration).
  </Accordion>

  <Accordion title="Does Homebrew work on Linux?">
    Yes, via Linuxbrew:

    ```bash
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
    brew install <formula>
    ```

    Running OpenClaw via systemd: make sure the service PATH includes
    `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools
    resolve in non-login shells. Recent builds also prepend common user bin dirs on Linux
    systemd services (for example `~/.local/bin`, `~/.npm-global/bin`,
    `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`,
    `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.

  </Accordion>

  <Accordion title="Difference between the hackable git install and npm install">
    - **Hackable (git) install:** full source checkout, editable, best for contributors. You build locally and can patch code/docs.
    - **npm install:** global CLI install, no repo, best for "just run it." Updates come from npm dist-tags.

    Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

  </Accordion>

  <Accordion title="Can I switch between npm and git installs later?">
    Yes, with `openclaw update --channel ...` on an existing install. This does **not
    delete your data** - only the OpenClaw code install changes. State (`~/.openclaw`) and
    workspace (`~/.openclaw/workspace`) stay untouched.

    npm to git:

    ```bash
    openclaw update --channel dev
    ```

    git to npm:

    ```bash
    openclaw update --channel stable
    ```

    Add `--dry-run` to preview the planned mode switch first. The updater runs Doctor
    follow-ups, refreshes plugin sources for the target channel, and restarts the gateway
    unless you pass `--no-restart`.

    The installer can force either mode too:

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method npm
    ```

    Backup tips: [Where things live on disk](/help/faq#where-things-live-on-disk).

  </Accordion>

  <Accordion title="Should I run the Gateway on my laptop or a VPS?">
    Want 24/7 reliability? Use a **VPS**. Want the lowest friction and you are OK with
    sleep/restarts? Run it locally.

    **Laptop (local Gateway)**

    - **Pros:** no server cost, direct access to local files, a live browser window.
    - **Cons:** sleep/network drops disconnect it, OS updates/reboots interrupt it, must stay awake.

    **VPS / cloud**

    - **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
    - **Cons:** often headless (use screenshots), remote file access only, SSH needed for updates.

    WhatsApp/Telegram/Slack/Mattermost/Discord all work fine from a VPS - the real
    trade-off is headless browser vs a visible window. See [Browser](/tools/browser).

    Default recommendation: VPS if you have had gateway disconnects before; local is great
    when you are actively using the Mac and want local file access or visible-browser UI
    automation.

  </Accordion>

  <Accordion title="How important is it to run OpenClaw on a dedicated machine?">
    Not required, but recommended for reliability and isolation.

    - **Dedicated host (VPS/Mac mini/Raspberry Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.
    - **Shared laptop/desktop:** fine for testing and active use, but expect pauses when the machine sleeps or updates.

    Best of both worlds: keep the Gateway on a dedicated host and pair your laptop as a
    **node** for local screen/camera/exec tools. See [Nodes](/nodes) and [Security](/gateway/security).

  </Accordion>

  <Accordion title="What are the minimum VPS requirements and recommended OS?">
    - **Absolute minimum:** 1 vCPU, 1 GB RAM, ~500 MB disk.
    - **Recommended:** 1-2 vCPU, 2 GB+ RAM for headroom (logs, media, multiple channels). Node tools and browser automation can be resource hungry.

    OS: **Ubuntu LTS** (or any modern Debian/Ubuntu) - the best-tested Linux install path.

    Docs: [Linux](/platforms/linux), [VPS hosting](/vps).

  </Accordion>

  <Accordion title="Can I run OpenClaw in a VM and what are the requirements?">
    Yes. Treat a VM like a VPS: it needs to be always on, reachable, and have enough RAM
    for the Gateway and any channels you enable.

    - **Absolute minimum:** 1 vCPU, 1 GB RAM.
    - **Recommended:** 2 GB+ RAM for multiple channels, browser automation, or media tools.
    - **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

    On Windows, use **Windows Hub** for desktop setup, or WSL2 for a Linux-style Gateway VM
    with broad tooling compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).
    Running macOS in a VM: see [macOS VM](/install/macos-vm).

  </Accordion>
</AccordionGroup>
