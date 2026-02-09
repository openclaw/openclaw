---
summary: "OpenClaw सेटअप, विन्यास और उपयोग से संबंधित अक्सर पूछे जाने वाले प्रश्न"
title: "FAQ"
---

# FAQ

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## Table of contents

- [Quick start and first-run setup]
  - [Im stuck whats the fastest way to get unstuck?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [What's the recommended way to install and set up OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [How do I open the dashboard after onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [How do I authenticate the dashboard (token) on localhost vs remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [What runtime do I need?](#what-runtime-do-i-need)
  - [Does it run on Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Any tips for Raspberry Pi installs?](#any-tips-for-raspberry-pi-installs)
  - [It is stuck on "wake up my friend" / onboarding will not hatch. What now?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Can I migrate my setup to a new machine (Mac mini) without redoing onboarding?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Where do I see what is new in the latest version?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [I can't access docs.openclaw.ai (SSL error). What now?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [What's the difference between stable and beta?](#whats-the-difference-between-stable-and-beta)
  - [How do I install the beta version, and what's the difference between beta and dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [How do I try the latest bits?](#how-do-i-try-the-latest-bits)
  - [How long does install and onboarding usually take?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer stuck? How do I get more feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows install says git not found or openclaw not recognized](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [The docs didn't answer my question - how do I get a better answer?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [How do I install OpenClaw on Linux?](#how-do-i-install-openclaw-on-linux)
  - [How do I install OpenClaw on a VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Where are the cloud/VPS install guides?](#where-are-the-cloudvps-install-guides)
  - [Can I ask OpenClaw to update itself?](#can-i-ask-openclaw-to-update-itself)
  - [What does the onboarding wizard actually do?](#what-does-the-onboarding-wizard-actually-do)
  - [Do I need a Claude or OpenAI subscription to run this?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Can I use Claude Max subscription without an API key](#can-i-use-claude-max-subscription-without-an-api-key)
  - [How does Anthropic "setup-token" auth work?](#how-does-anthropic-setuptoken-auth-work)
  - [Where do I find an Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Do you support Claude subscription auth (Claude Pro or Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Why am I seeing `HTTP 429: rate_limit_error` from Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Is AWS Bedrock supported?](#is-aws-bedrock-supported)
  - [How does Codex auth work?](#how-does-codex-auth-work)
  - [Do you support OpenAI subscription auth (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [How do I set up Gemini CLI OAuth](#how-do-i-set-up-gemini-cli-oauth)
  - [Is a local model OK for casual chats?](#is-a-local-model-ok-for-casual-chats)
  - [How do I keep hosted model traffic in a specific region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Do I have to buy a Mac Mini to install this?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Do I need a Mac mini for iMessage support?](#do-i-need-a-mac-mini-for-imessage-support)
  - [If I buy a Mac mini to run OpenClaw, can I connect it to my MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Can I use Bun?](#can-i-use-bun)
  - [Telegram: what goes in `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Can multiple people use one WhatsApp number with different OpenClaw instances?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Can I run a "fast chat" agent and an "Opus for coding" agent?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Does Homebrew work on Linux?](#does-homebrew-work-on-linux)
  - [What's the difference between the hackable (git) install and npm install?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Can I switch between npm and git installs later?](#can-i-switch-between-npm-and-git-installs-later)
  - [Should I run the Gateway on my laptop or a VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [How important is it to run OpenClaw on a dedicated machine?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [What are the minimum VPS requirements and recommended OS?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Can I run OpenClaw in a VM and what are the requirements](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
- [What is OpenClaw?](#what-is-openclaw)
  - [What is OpenClaw, in one paragraph?](#what-is-openclaw-in-one-paragraph)
  - [What's the value proposition?](#whats-the-value-proposition)
  - [I just set it up what should I do first](#i-just-set-it-up-what-should-i-do-first)
  - [What are the top five everyday use cases for OpenClaw](#what-are-the-top-five-everyday-use-cases-for-openclaw)
  - [Can OpenClaw help with lead gen outreach ads and blogs for a SaaS](#can-openclaw-help-with-lead-gen-outreach-ads-and-blogs-for-a-saas)
  - [What are the advantages vs Claude Code for web development?](#what-are-the-advantages-vs-claude-code-for-web-development)
- [Skills and automation](#skills-and-automation)
  - [How do I customize skills without keeping the repo dirty?](#how-do-i-customize-skills-without-keeping-the-repo-dirty)
  - [Can I load skills from a custom folder?](#can-i-load-skills-from-a-custom-folder)
  - [How can I use different models for different tasks?](#how-can-i-use-different-models-for-different-tasks)
  - [The bot freezes while doing heavy work. How do I offload that?](#the-bot-freezes-while-doing-heavy-work-how-do-i-offload-that)
  - [Cron or reminders do not fire. What should I check?](#cron-or-reminders-do-not-fire-what-should-i-check)
  - [How do I install skills on Linux?](#how-do-i-install-skills-on-linux)
  - [Can OpenClaw run tasks on a schedule or continuously in the background?](#can-openclaw-run-tasks-on-a-schedule-or-continuously-in-the-background)
  - [Can I run Apple macOS-only skills from Linux?](#can-i-run-apple-macos-only-skills-from-linux)
  - [Do you have a Notion or HeyGen integration?](#do-you-have-a-notion-or-heygen-integration)
  - [How do I install the Chrome extension for browser takeover?](#how-do-i-install-the-chrome-extension-for-browser-takeover)
- [Sandboxing and memory](#sandboxing-and-memory)
  - [Is there a dedicated sandboxing doc?](#is-there-a-dedicated-sandboxing-doc)
  - [How do I bind a host folder into the sandbox?](#how-do-i-bind-a-host-folder-into-the-sandbox)
  - [How does memory work?](#how-does-memory-work)
  - [Memory keeps forgetting things. How do I make it stick?](#memory-keeps-forgetting-things-how-do-i-make-it-stick)
  - [Does memory persist forever? What are the limits?](#does-memory-persist-forever-what-are-the-limits)
  - [Does semantic memory search require an OpenAI API key?](#does-semantic-memory-search-require-an-openai-api-key)
- [Where things live on disk](#where-things-live-on-disk)
  - [Is all data used with OpenClaw saved locally?](#is-all-data-used-with-openclaw-saved-locally)
  - [OpenClaw अपना डेटा कहाँ संग्रहीत करता है?](#where-does-openclaw-store-its-data)
  - [Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?](#where-should-agentsmd-soulmd-usermd-memorymd-live)
  - [What's the recommended backup strategy?](#whats-the-recommended-backup-strategy)
  - [How do I completely uninstall OpenClaw?](#how-do-i-completely-uninstall-openclaw)
  - [Can agents work outside the workspace?](#can-agents-work-outside-the-workspace)
  - [I'm in remote mode - where is the session store?](#im-in-remote-mode-where-is-the-session-store)
- [Config basics](#config-basics)
  - [What format is the config? Where is it?](#what-format-is-the-config-where-is-it)
  - [I set `gateway.bind: "lan"` (or `"tailnet"`) and now nothing listens / the UI says unauthorized](#i-set-gatewaybind-lan-or-tailnet-and-now-nothing-listens-the-ui-says-unauthorized)
  - [Why do I need a token on localhost now?](#why-do-i-need-a-token-on-localhost-now)
  - [Do I have to restart after changing config?](#do-i-have-to-restart-after-changing-config)
  - [How do I enable web search (and web fetch)?](#how-do-i-enable-web-search-and-web-fetch)
  - [config.apply wiped my config. How do I recover and avoid this?](#configapply-wiped-my-config-how-do-i-recover-and-avoid-this)
  - [How do I run a central Gateway with specialized workers across devices?](#how-do-i-run-a-central-gateway-with-specialized-workers-across-devices)
  - [Can the OpenClaw browser run headless?](#can-the-openclaw-browser-run-headless)
  - [How do I use Brave for browser control?](#how-do-i-use-brave-for-browser-control)
- [Remote gateways and nodes](#remote-gateways-and-nodes)
  - [How do commands propagate between Telegram, the gateway, and nodes?](#how-do-commands-propagate-between-telegram-the-gateway-and-nodes)
  - [How can my agent access my computer if the Gateway is hosted remotely?](#how-can-my-agent-access-my-computer-if-the-gateway-is-hosted-remotely)
  - [Tailscale is connected but I get no replies. What now?](#tailscale-is-connected-but-i-get-no-replies-what-now)
  - [Can two OpenClaw instances talk to each other (local + VPS)?](#can-two-openclaw-instances-talk-to-each-other-local-vps)
  - [Do I need separate VPSes for multiple agents](#do-i-need-separate-vpses-for-multiple-agents)
  - [Is there a benefit to using a node on my personal laptop instead of SSH from a VPS?](#is-there-a-benefit-to-using-a-node-on-my-personal-laptop-instead-of-ssh-from-a-vps)
  - [Do nodes run a gateway service?](#do-nodes-run-a-gateway-service)
  - [Is there an API / RPC way to apply config?](#is-there-an-api-rpc-way-to-apply-config)
  - [पहली इंस्टॉलेशन के लिए न्यूनतम "सane" कॉन्फ़िग क्या है?](#whats-a-minimal-sane-config-for-a-first-install)
  - [How do I set up Tailscale on a VPS and connect from my Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [How do I connect a Mac node to a remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Should I install on a second laptop or just add a node?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars and .env loading](#env-vars-and-env-loading)
  - [How does OpenClaw load environment variables?](#how-does-openclaw-load-environment-variables)
  - ["I started the Gateway via the service and my env vars disappeared." What now?](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [I set `COPILOT_GITHUB_TOKEN`, but models status shows "Shell env: off." Why?](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [Sessions and multiple chats](#sessions-and-multiple-chats)
  - [How do I start a fresh conversation?](#how-do-i-start-a-fresh-conversation)
  - [Do sessions reset automatically if I never send `/new`?](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Is there a way to make a team of OpenClaw instances one CEO and many agents](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [Why did context get truncated mid-task? How do I prevent it?](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [How do I completely reset OpenClaw but keep it installed?](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [I'm getting "context too large" errors - how do I reset or compact?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [Why am I seeing "LLM request rejected: messages.N.content.X.tool_use.input: Field required"?](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [Why am I getting heartbeat messages every 30 minutes?](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [Do I need to add a "bot account" to a WhatsApp group?](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [How do I get the JID of a WhatsApp group?](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [Why doesn't OpenClaw reply in a group?](#why-doesnt-openclaw-reply-in-a-group)
  - [Do groups/threads share context with DMs?](#do-groupsthreads-share-context-with-dms)
  - [How many workspaces and agents can I create?](#how-many-workspaces-and-agents-can-i-create)
  - [Can I run multiple bots or chats at the same time (Slack), and how should I set that up?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [Models: defaults, selection, aliases, switching](#models-defaults-selection-aliases-switching)
  - [What is the "default model"?](#what-is-the-default-model)
  - [What model do you recommend?](#what-model-do-you-recommend)
  - [How do I switch models without wiping my config?](#how-do-i-switch-models-without-wiping-my-config)
  - [Can I use self-hosted models (llama.cpp, vLLM, Ollama)?](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [What do OpenClaw, Flawd, and Krill use for models?](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [How do I switch models on the fly (without restarting)?](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [Can I use GPT 5.2 for daily tasks and Codex 5.3 for coding](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - 1. [मुझे "Model …
    2. is not allowed" क्यों दिखाई देता है और फिर कोई जवाब नहीं आता?](#why-do-i-see-model-is-not-allowed-and-then-no-reply) 3. [मुझे "Unknown model: minimax/MiniMax-M2.1" क्यों दिखाई देता है?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - 4. [क्या मैं MiniMax को अपना डिफ़ॉल्ट और जटिल कार्यों के लिए OpenAI का उपयोग कर सकता हूँ?](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - 5. [क्या opus / sonnet / gpt बिल्ट-इन शॉर्टकट हैं?](#are-opus-sonnet-gpt-builtin-shortcuts)
  - 6. [मैं मॉडल शॉर्टकट (aliases) को कैसे परिभाषित/ओवरराइड करूँ?](#how-do-i-defineoverride-model-shortcuts-aliases)
  - 7. [मैं OpenRouter या Z.AI जैसे अन्य प्रदाताओं से मॉडल कैसे जोड़ूँ?](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
  - 8. [फेलओवर कैसे काम करता है?](#how-does-failover-work)
- [Model failover and "All models failed"](#model-failover-and-all-models-failed)
  - 9. [इस त्रुटि का क्या अर्थ है?](#what-does-this-error-mean)
  - 10. [`No credentials found for profile "anthropic:default"` के लिए फिक्स चेकलिस्ट](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [`No credentials found for profile "anthropic:default"` के लिए फ़िक्स चेकलिस्ट](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - 12. [Auth प्रोफ़ाइल क्या होती है?](#what-is-an-auth-profile)
- [Auth profiles: what they are and how to manage them](#auth-profiles-what-they-are-and-how-to-manage-them)
  - 13. [सामान्य प्रोफ़ाइल ID क्या होती हैं?](#what-are-typical-profile-ids)
  - 14. [क्या मैं नियंत्रित कर सकता हूँ कि कौन-सी auth प्रोफ़ाइल पहले आज़माई जाए?](#can-i-control-which-auth-profile-is-tried-first)
  - 15. [OAuth बनाम API key: क्या अंतर है?](#oauth-vs-api-key-whats-the-difference)
  - 16. [Gateway कौन-सा पोर्ट उपयोग करता है?](#what-port-does-the-gateway-use)
- [Gateway: ports, "already running", and remote mode](#gateway-ports-already-running-and-remote-mode)
  - 17. [`openclaw gateway status` में `Runtime: running` दिखता है लेकिन `RPC probe: failed` क्यों दिखता है?](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - 18. [`openclaw gateway status` में `Config (cli)` और `Config (service)` अलग-अलग क्यों दिखते हैं?](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - 19. ["another gateway instance is already listening" का क्या मतलब है?](#what-does-another-gateway-instance-is-already-listening-mean)
  - 20. [मैं OpenClaw को रिमोट मोड में कैसे चलाऊँ (क्लाइंट कहीं और मौजूद Gateway से कनेक्ट होता है)?](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - 21. [Control UI में "unauthorized" लिखा आता है (या यह बार-बार reconnect होता रहता है)।
    22. अब क्या करूँ?](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now)
  - 23. [मैंने `gateway.bind: "tailnet"` सेट किया है लेकिन यह bind नहीं हो पा रहा / कुछ भी listen नहीं कर रहा](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens) 24. [क्या मैं एक ही होस्ट पर कई Gateways चला सकता हूँ?](#can-i-run-multiple-gateways-on-the-same-host)
  - 25. ["invalid handshake" / code 1008 का क्या मतलब है?](#what-does-invalid-handshake-code-1008-mean)
  - 26. [लॉग्स कहाँ हैं?](#where-are-logs)
  - 27. [मैं Gateway सेवा को कैसे start/stop/restart करूँ?](#how-do-i-startstoprestart-the-gateway-service)
- [Logging and debugging](#logging-and-debugging)
  - 28. [मैंने Windows पर अपना टर्मिनल बंद कर दिया — OpenClaw को फिर से कैसे शुरू करूँ?](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - 29. [Gateway चालू है लेकिन जवाब कभी नहीं आते।
    30. मुझे क्या जाँचना चाहिए?](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - 31. ["Disconnected from gateway: no reason" — अब क्या?](#disconnected-from-gateway-no-reason-what-now)
  - 32. [Telegram setMyCommands नेटवर्क त्रुटियों के साथ विफल हो रहा है।
    33. मुझे क्या जाँचना चाहिए?](#telegram-setmycommands-fails-with-network-errors-what-should-i-check) 34. [TUI में कोई आउटपुट नहीं दिखता।
    34. मुझे क्या जाँचना चाहिए?](#tui-shows-no-output-what-should-i-check)
  - 36. [मैं Gateway को पूरी तरह कैसे रोकूँ और फिर शुरू करूँ?](#how-do-i-completely-stop-then-start-the-gateway)
  - 37. [ELI5: `openclaw gateway restart` बनाम `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway) 38. [जब कुछ विफल हो जाए तो अधिक विवरण जल्दी से पाने का सबसे तेज़ तरीका क्या है?](#whats-the-fastest-way-to-get-more-details-when-something-fails)
  - 39. [मेरी skill ने एक image/PDF जनरेट किया, लेकिन कुछ भी भेजा नहीं गया](#my-skill-generated-an-imagepdf-but-nothing-was-sent) 40. [क्या OpenClaw को इनबाउंड DMs के लिए एक्सपोज़ करना सुरक्षित है?](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - 41. [क्या prompt injection केवल पब्लिक बॉट्स के लिए ही चिंता का विषय है?](#is-prompt-injection-only-a-concern-for-public-bots)
  - 42. [क्या मेरे बॉट के लिए अलग ईमेल, GitHub अकाउंट या फोन नंबर होना चाहिए](#should-my-bot-have-its-own-email-github-account-or-phone-number)
  - 43. [क्या मैं इसे अपने टेक्स्ट मैसेज पर स्वायत्तता दे सकता हूँ और क्या यह सुरक्षित है](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
- [Media and attachments](#media-and-attachments)
  - 44. [क्या मैं पर्सनल असिस्टेंट कार्यों के लिए सस्ते मॉडल इस्तेमाल कर सकता हूँ?](#can-i-use-cheaper-models-for-personal-assistant-tasks)
- [Security and access control](#security-and-access-control)
  - 45. [मैंने Telegram में `/start` चलाया लेकिन मुझे pairing code नहीं मिला](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - 46. [WhatsApp: क्या यह मेरे कॉन्टैक्ट्स को मैसेज करेगा?
    47. pairing कैसे काम करता है?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
  - 48. [मैं इंटरनल सिस्टम मैसेज को चैट में दिखने से कैसे रोकूँ](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - 49. [मैं किसी चल रहे टास्क को कैसे रोकूँ/रद्द करूँ?](#how-do-i-stopcancel-a-running-task)
  - 50. [मैं Telegram से Discord संदेश कैसे भेजूँ?](#how-do-i-send-a-discord-message-from-telegram)
  - [I ran `/start` in Telegram but didn't get a pairing code](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - [WhatsApp: will it message my contacts? How does pairing work?](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
- [Chat commands, aborting tasks, and "it won't stop"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [How do I stop internal system messages from showing in chat](#how-do-i-stop-internal-system-messages-from-showing-in-chat)
  - [How do I stop/cancel a running task?](#how-do-i-stopcancel-a-running-task)
  - [How do I send a Discord message from Telegram? ("क्रॉस-कॉन्टेक्स्ट मैसेजिंग अस्वीकृत")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied)
  - [क्यों ऐसा लगता है कि बॉट तेज़-तर्रार संदेशों को "नज़रअंदाज़" करता है?](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)

## First 60 seconds if something's broken

1. **त्वरित स्थिति (पहली जाँच)**

   ```bash
   openclaw status
   ```

   तेज़ स्थानीय सारांश: OS + अपडेट, Gateway/सेवा की पहुँच, एजेंट/सत्र, प्रदाता विन्यास + रनटाइम समस्याएँ (जब Gateway पहुँचे योग्य हो)।

2. **कॉपी‑पेस्ट करने योग्य रिपोर्ट (साझा करने के लिए सुरक्षित)**

   ```bash
   openclaw status --all
   ```

   केवल-पढ़ने योग्य निदान, लॉग टेल के साथ (टोकन हटाए गए)।

3. **डेमन + पोर्ट स्थिति**

   ```bash
   openclaw gateway status
   ```

   सुपरवाइज़र रनटाइम बनाम RPC पहुँच, प्रोब लक्ष्य URL, और सेवा द्वारा प्रयुक्त संभावित विन्यास दिखाता है।

4. **गहन प्रोब्स**

   ```bash
   openclaw status --deep
   ```

   गेटवे हेल्थ चेक + प्रोवाइडर प्रोब्स चलाता है (एक पहुँच योग्य गेटवे आवश्यक है)। देखें [Health](/gateway/health)।

5. **नवीनतम लॉग टेल करें**

   ```bash
   openclaw logs --follow
   ```

   यदि RPC डाउन है, तो इसके बजाय:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   फ़ाइल लॉग सेवा लॉग से अलग होते हैं; [Logging](/logging) और [Troubleshooting](/gateway/troubleshooting) देखें।

6. **डॉक्टर चलाएँ (मरम्मत)**

   ```bash
   openclaw doctor
   ```

   कॉन्फ़िग/स्टेट की मरम्मत/माइग्रेशन करता है + हेल्थ चेक चलाता है। [Doctor](/gateway/doctor) देखें।

7. **Gateway स्नैपशॉट**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   चल रहे गेटवे से पूरा स्नैपशॉट माँगता है (केवल WS)। देखें [Health](/gateway/health)।

## Quick start and first-run setup

### Im stuck whats the fastest way to get unstuck

एक लोकल AI एजेंट का उपयोग करें जो **आपकी मशीन देख सकता है**। यह Discord में पूछने से कहीं अधिक प्रभावी है, क्योंकि ज़्यादातर "मैं फँस गया हूँ" मामलों में **लोकल कॉन्फ़िग या एनवायरनमेंट समस्याएँ** होती हैं जिन्हें रिमोट हेल्पर्स देख नहीं सकते।

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

ये टूल्स रेपो पढ़ सकते हैं, कमांड चला सकते हैं, लॉग्स जाँच सकते हैं, और आपकी मशीन-लेवल सेटअप (PATH, सेवाएँ, परमिशन्स, ऑथ फ़ाइलें) ठीक करने में मदद कर सकते हैं। उन्हें **पूरा सोर्स चेकआउट** दें
हैक करने योग्य (git) इंस्टॉल के ज़रिये:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

यह OpenClaw को **git चेकआउट से** इंस्टॉल करता है, ताकि एजेंट कोड + डॉक्स पढ़ सके और आप जो सटीक वर्शन चला रहे हैं उस पर तर्क कर सके। आप बाद में हमेशा स्टेबल पर वापस स्विच कर सकते हैं
`--install-method git` के बिना इंस्टॉलर को फिर से चलाकर।

टिप: एजेंट से फ़िक्स को **प्लान और सुपरवाइज़** (स्टेप-बाय-स्टेप) करने को कहें, फिर केवल आवश्यक कमांड्स ही चलाएँ। इससे बदलाव छोटे रहते हैं और ऑडिट करना आसान होता है।

यदि आपको कोई वास्तविक बग या फिक्स मिले, तो कृपया GitHub इश्यू दर्ज करें या PR भेजें:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

मदद माँगते समय इन कमांड से शुरू करें (आउटपुट साझा करें):

```bash
openclaw status
openclaw models status
openclaw doctor
```

ये क्या करते हैं:

- `openclaw status`: Gateway/एजेंट स्वास्थ्य + बुनियादी विन्यास का त्वरित स्नैपशॉट।
- `openclaw models status`: प्रदाता प्रमाणीकरण + मॉडल उपलब्धता जाँचता है।
- `openclaw doctor`: सामान्य विन्यास/स्थिति समस्याओं को सत्यापित और ठीक करता है।

अन्य उपयोगी CLI जाँचें: `openclaw status --all`, `openclaw logs --follow`, `openclaw gateway status`, `openclaw health --verbose`।

त्वरित डिबग लूप: [First 60 seconds if something's broken](#first-60-seconds-if-somethings-broken)।
इंस्टॉल डॉक्स: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating)।

### OpenClaw को इंस्टॉल और सेट अप करने का सुझाया गया तरीका क्या है

**अभी भी अटके हैं?** [Discord](https://discord.com/invite/clawd) में पूछें या [GitHub discussion](https://github.com/openclaw/openclaw/discussions) खोलें।

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

विज़ार्ड UI एसेट्स को अपने-आप भी बना सकता है। ऑनबोर्डिंग के बाद, आप आम तौर पर गेटवे को पोर्ट **18789** पर चलाते हैं।

सोर्स से (कॉन्ट्रिब्यूटर्स/डेव):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # पहली रन पर UI डिप्स अपने-आप इंस्टॉल होती हैं
openclaw onboard
```

अगर आपके पास अभी ग्लोबल इंस्टॉल नहीं है, तो इसे `pnpm openclaw onboard` के ज़रिये चलाएँ।

### ऑनबोर्डिंग के बाद मैं डैशबोर्ड कैसे खोलूँ

विज़ार्ड ऑनबोर्डिंग के तुरंत बाद आपके ब्राउज़र को एक साफ़ (नॉन-टोकनाइज़्ड) डैशबोर्ड URL के साथ खोलता है और सारांश में लिंक भी प्रिंट करता है। उस टैब को खुला रखें; अगर यह लॉन्च नहीं हुआ, तो उसी मशीन पर प्रिंट किया गया URL कॉपी/पेस्ट करें।

### localhost बनाम रिमोट पर डैशबोर्ड टोकन को कैसे ऑथेंटिकेट करूँ

**Localhost (उसी मशीन पर):**

- `http://127.0.0.1:18789/` खोलें।
- अगर यह ऑथ माँगे, तो `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`) से टोकन को Control UI सेटिंग्स में पेस्ट करें।
- इसे गेटवे होस्ट से प्राप्त करें: `openclaw config get gateway.auth.token` (या एक जनरेट करें: `openclaw doctor --generate-gateway-token`)।

**लोकलहोस्ट पर नहीं:**

- **Tailscale Serve** (सुझाया गया): loopback बाइंड रखें, `openclaw gateway --tailscale serve` चलाएँ, `https://<magicdns>/` खोलें। अगर `gateway.auth.allowTailscale` `true` है, तो आइडेंटिटी हेडर्स ऑथ को संतुष्ट करते हैं (टोकन नहीं)।
- **Tailnet bind**: `openclaw gateway --bind tailnet --token "<token>"` चलाएँ, `http://<tailscale-ip>:18789/` खोलें, डैशबोर्ड सेटिंग्स में टोकन पेस्ट करें।
- **SSH टनल**: `ssh -N -L 18789:127.0.0.1:18789 user@host` फिर `http://127.0.0.1:18789/` खोलें और Control UI सेटिंग्स में टोकन पेस्ट करें।

बाइंड मोड्स और ऑथ विवरण के लिए [Dashboard](/web/dashboard) और [Web surfaces](/web) देखें।

### मुझे कौन सा रनटाइम चाहिए

Node **>= 22** आवश्यक है। `pnpm` की सिफ़ारिश की जाती है। Gateway के लिए Bun **सुझाया नहीं जाता**।

### क्या यह Raspberry Pi पर चलता है

हाँ। Gateway हल्का है — डॉक्स में पर्सनल उपयोग के लिए **512MB–1GB RAM**, **1 core**, और लगभग **500MB** डिस्क को पर्याप्त बताया गया है, और यह भी नोट किया गया है कि **Raspberry Pi 4 इसे चला सकता है**।

अगर आपको अतिरिक्त हेडरूम (लॉग्स, मीडिया, अन्य सेवाएँ) चाहिए, तो **2GB सुझाया जाता है**, लेकिन यह कोई सख़्त न्यूनतम नहीं है।

टिप: एक छोटा Pi/VPS Gateway होस्ट कर सकता है, और आप अपने लैपटॉप/फ़ोन पर **nodes** पेयर कर सकते हैं ताकि लोकल स्क्रीन/कैमरा/कैनवस या कमांड एक्सीक्यूशन मिल सके। देखें [Nodes](/nodes)।

### Raspberry Pi इंस्टॉल के लिए कोई सुझाव

संक्षिप्त संस्करण: यह काम करता है, लेकिन कुछ खुरदरे किनारों की उम्मीद रखें।

- **64-bit** OS का उपयोग करें और Node >= 22 रखें।
- लॉग देखने और तेज़ी से अपडेट करने के लिए **हैक करने योग्य (git) इंस्टॉल** को प्राथमिकता दें।
- चैनल/स्किल्स के बिना शुरू करें, फिर उन्हें एक-एक करके जोड़ें।
- यदि आपको अजीब बाइनरी समस्याएँ मिलें, तो आमतौर पर यह **ARM compatibility** समस्या होती है।

डॉक्स: [Linux](/platforms/linux), [Install](/install).

### यह "Wake up my friend" onboarding पर अटका हुआ है, हैच नहीं हो रहा। अब क्या करें?

वह स्क्रीन इस बात पर निर्भर करती है कि Gateway पहुँचा जा सकता है और authenticated है या नहीं। TUI भी पहले hatch पर स्वतः "Wake up, my friend!" भेजता है।

1. यदि आप वह पंक्ति **बिना किसी जवाब** के देखते हैं

```bash
openclaw gateway restart
```

2. और tokens 0 पर ही रहते हैं, तो agent कभी चला ही नहीं।

```bash
Gateway को रीस्टार्ट करें:
```

3. स्थिति + auth जाँचें:

```bash
openclaw doctor
```

यदि Gateway रिमोट है, तो सुनिश्चित करें कि टनल/Tailscale कनेक्शन चालू है और UI सही Gateway की ओर इशारा कर रहा है। देखें [Remote access](/gateway/remote)।

### openclaw models status

openclaw logs --follow यदि यह अभी भी अटका रहता है, तो चलाएँ: यदि Gateway remote है, तो सुनिश्चित करें कि tunnel/Tailscale कनेक्शन चालू है और UI

1. सही Gateway की ओर इशारा कर रहा है।
2. क्या मैं onboarding दोबारा किए बिना अपने सेटअप को नए Mac mini मशीन पर माइग्रेट कर सकता हूँ?
3. हाँ।
4. **state directory** और **workspace** कॉपी करें, फिर Doctor एक बार चलाएँ।

यह आपके बॉट को "बिल्कुल वैसा ही" रखता है (memory, session history, auth, और channel

state) बशर्ते आप **दोनों** स्थान कॉपी करें: ये `~/.openclaw/` के तहत होते हैं (उदाहरण के लिए `~/.openclaw/agents/<agentId>/sessions/`)।

पुरानी मशीन से `$OPENCLAW_STATE_DIR` (डिफ़ॉल्ट: `~/.openclaw`) कॉपी करें।

### अपना workspace कॉपी करें (डिफ़ॉल्ट: `~/.openclaw/workspace`)।

`openclaw doctor` चलाएँ और Gateway सेवा को रीस्टार्ट करें।

इससे config, auth profiles, WhatsApp creds, sessions, और memory सुरक्षित रहती हैं। यदि आप remote mode में हैं, तो याद रखें कि gateway host ही session store और workspace का मालिक होता है।

### **महत्वपूर्ण:** यदि आप केवल अपना workspace GitHub पर commit/push करते हैं, तो आप

**memory + bootstrap files** का बैकअप ले रहे होते हैं, लेकिन **session history या auth** का नहीं। वे `~/.openclaw/` के अंतर्गत रहते हैं (उदाहरण के लिए `~/.openclaw/agents/<agentId>/sessions/`)।
संबंधित: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),

[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),

### [Remote mode](/gateway/remote).

नवीनतम संस्करण में नया क्या है, मैं कहाँ देख सकता हूँ?

- GitHub changelog देखें:
- [https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

सबसे नए entries ऊपर होते हैं। यदि ऊपर वाला सेक्शन **Unreleased** के रूप में चिह्नित है, तो उसके बाद वाला दिनांकित

सेक्शन ही नवीनतम जारी किया गया संस्करण है।

### Entries को **Highlights**, **Changes**, और

**Fixes** (और ज़रूरत पड़ने पर docs/अन्य सेक्शन) के अनुसार समूहित किया गया है।
मैं docs.openclaw.ai एक्सेस नहीं कर पा रहा हूँ, SSL error आ रहा है। अब क्या करें?

कुछ Comcast/Xfinity कनेक्शन गलती से Xfinity Advanced Security के ज़रिये `docs.openclaw.ai` को ब्लॉक कर देते हैं।

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows installer (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

More detail: [Development channels](/install/development-channels) and [Installer flags](/install/installer).

### How long does install and onboarding usually take

Rough guide:

- **Install:** 2-5 minutes
- **Onboarding:** 5-15 minutes depending on how many channels/models you configure

If it hangs, use [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
and the fast debug loop in [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck).

### How do I try the latest bits

दो विकल्प:

1. **Dev channel (git checkout):**

```bash
openclaw update --channel dev
```

This switches to the `main` branch and updates from source.

2. **Hackable install (from the installer site):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

इससे आपको एक लोकल रिपॉज़िटरी मिलती है जिसे आप संपादित कर सकते हैं, फिर git के ज़रिये अपडेट कर सकते हैं।

If you prefer a clean clone manually, use:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update), [Development channels](/install/development-channels),
[Install](/install).

### Installer stuck How do I get more feedback

Re-run the installer with **verbose output**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

Beta install with verbose:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

For a hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

More options: [Installer flags](/install/installer).

### Windows install says git not found or openclaw not recognized

Two common Windows issues:

**1) npm error spawn git / git not found**

- Install **Git for Windows** and make sure `git` is on your PATH.
- Close and reopen PowerShell, then re-run the installer.

**2) इंस्टॉल के बाद openclaw पहचाना नहीं जाता**

- Your npm global bin folder is not on PATH.

- Check the path:

  ```powershell
  npm config get prefix
  ```

- Ensure `<prefix>\\bin` is on PATH (on most systems it is `%AppData%\\npm`).

- Close and reopen PowerShell after updating PATH.

यदि आप सबसे स्मूद Windows सेटअप चाहते हैं, तो नेटिव Windows की बजाय **WSL2** का उपयोग करें।
Docs: [Windows](/platforms/windows).

### The docs didnt answer my question how do I get a better answer

Use the **hackable (git) install** so you have the full source and docs locally, then ask
your bot (or Claude/Codex) _from that folder_ so it can read the repo and answer precisely.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

More detail: [Install](/install) and [Installer flags](/install/installer).

### How do I install OpenClaw on Linux

Short answer: follow the Linux guide, then run the onboarding wizard.

- Linux quick path + service install: [Linux](/platforms/linux).
- Full walkthrough: [Getting Started](/start/getting-started).
- Installer + updates: [Install & updates](/install/updating).

### How do I install OpenClaw on a VPS

Any Linux VPS works. Install on the server, then use SSH/Tailscale to reach the Gateway.

Guides: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
Remote access: [Gateway remote](/gateway/remote).

### Where are the cloudVPS install guides

We keep a **hosting hub** with the common providers. Pick one and follow the guide:

- [VPS hosting](/vps) (all providers in one place)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

How it works in the cloud: the **Gateway runs on the server**, and you access it
from your laptop/phone via the Control UI (or Tailscale/SSH). Your state + workspace
live on the server, so treat the host as the source of truth and back it up.

You can pair **nodes** (Mac/iOS/Android/headless) to that cloud Gateway to access
local screen/camera/canvas or run commands on your laptop while keeping the
Gateway in the cloud.

Hub: [Platforms](/platforms). Remote access: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### Can I ask OpenClaw to update itself

Short answer: **possible, not recommended**. The update flow can restart the
Gateway (which drops the active session), may need a clean git checkout, and
can prompt for confirmation. Safer: run updates from a shell as the operator.

Use the CLI:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

If you must automate from an agent:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Docs: [Update](/cli/update), [Updating](/install/updating).

### What does the onboarding wizard actually do

`openclaw onboard` is the recommended setup path. In **local mode** it walks you through:

- **Model/auth setup** (Anthropic **setup-token** recommended for Claude subscriptions, OpenAI Codex OAuth supported, API keys optional, LM Studio local models supported)
- **Workspace** location + bootstrap files
- **Gateway settings** (bind/port/auth/tailscale)
- **Providers** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)
- **Health checks** and **skills** selection

It also warns if your configured model is unknown or missing auth.

### Do I need a Claude or OpenAI subscription to run this

No. You can run OpenClaw with **API keys** (Anthropic/OpenAI/others) or with
**local-only models** so your data stays on your device. Subscriptions (Claude
Pro/Max or OpenAI Codex) are optional ways to authenticate those providers.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Local models](/gateway/local-models), [Models](/concepts/models).

### Can I use Claude Max subscription without an API key

Yes. You can authenticate with a **setup-token**
instead of an API key. This is the subscription path.

Claude Pro/Max subscriptions **do not include an API key**, so this is the
correct approach for subscription accounts. Important: you must verify with
Anthropic that this usage is allowed under their subscription policy and terms.
If you want the most explicit, supported path, use an Anthropic API key.

### How does Anthropic setuptoken auth work

`claude setup-token` generates a **token string** via the Claude Code CLI (it is not available in the web console). You can run it on **any machine**. Choose **Anthropic token (paste setup-token)** in the wizard or paste it with `openclaw models auth paste-token --provider anthropic`. टोकन को **anthropic** प्रोवाइडर के लिए एक auth प्रोफ़ाइल के रूप में स्टोर किया जाता है और इसे API key की तरह इस्तेमाल किया जाता है (कोई auto-refresh नहीं)। अधिक विवरण: [OAuth](/concepts/oauth)।

### मैं Anthropic setup-token कहाँ ढूँढूँ

यह Anthropic Console में **नहीं** होता। setup-token **Claude Code CLI** द्वारा **किसी भी मशीन** पर जनरेट किया जाता है:

```bash
claude setup-token
```

CLI जो टोकन प्रिंट करता है उसे कॉपी करें, फिर wizard में **Anthropic token (paste setup-token)** चुनें। यदि आप इसे gateway host पर चलाना चाहते हैं, तो `openclaw models auth setup-token --provider anthropic` का उपयोग करें। यदि आपने `claude setup-token` कहीं और चलाया है, तो उसे gateway host पर `openclaw models auth paste-token --provider anthropic` के साथ पेस्ट करें। देखें [Anthropic](/providers/anthropic)।

### क्या आप Claude subscription auth (Claude Pro या Max) को सपोर्ट करते हैं

हाँ - **setup-token** के माध्यम से। OpenClaw अब Claude Code CLI OAuth टोकन का पुनः उपयोग नहीं करता; setup-token या Anthropic API key का उपयोग करें। टोकन कहीं भी जनरेट करें और उसे gateway host पर पेस्ट करें। देखें [Anthropic](/providers/anthropic) और [OAuth](/concepts/oauth)।

नोट: Claude subscription एक्सेस Anthropic की शर्तों द्वारा नियंत्रित होता है। प्रोडक्शन या multi-user वर्कलोड के लिए, API keys आमतौर पर अधिक सुरक्षित विकल्प होती हैं।

### मुझे Anthropic से HTTP 429 ratelimiterror क्यों दिख रहा है

इसका मतलब है कि वर्तमान विंडो के लिए आपका **Anthropic quota/rate limit** समाप्त हो गया है। यदि आप
एक **Claude subscription** (setup-token या Claude Code OAuth) का उपयोग करते हैं, तो विंडो के
रीसेट होने का इंतज़ार करें या अपनी योजना अपग्रेड करें। यदि आप **Anthropic API key** का उपयोग करते हैं, तो उपयोग/बिलिंग के लिए Anthropic Console
देखें और आवश्यकता अनुसार लिमिट बढ़ाएँ।

टिप: एक **fallback model** सेट करें ताकि कोई प्रोवाइडर rate-limited होने पर भी OpenClaw जवाब देता रहे।
देखें [Models](/cli/models) और [OAuth](/concepts/oauth)।

### क्या AWS Bedrock समर्थित है

हाँ - pi-ai के **Amazon Bedrock (Converse)** प्रोवाइडर के माध्यम से **manual config** के साथ। आपको gateway host पर AWS credentials/region प्रदान करना होगा और अपने models config में एक Bedrock provider entry जोड़नी होगी। देखें [Amazon Bedrock](/providers/bedrock) और [Model providers](/providers/models)। यदि आप managed key flow पसंद करते हैं, तो Bedrock के सामने एक OpenAI-compatible proxy अभी भी एक वैध विकल्प है।

### Codex auth कैसे काम करता है

OpenClaw OAuth (ChatGPT sign-in) के माध्यम से **OpenAI Code (Codex)** को सपोर्ट करता है। wizard OAuth flow चला सकता है और उपयुक्त होने पर default model को `openai-codex/gpt-5.3-codex` पर सेट कर देगा। देखें [Model providers](/concepts/model-providers) और [Wizard](/start/wizard)।

### क्या आप OpenAI subscription auth Codex OAuth को सपोर्ट करते हैं

हाँ। OpenClaw **OpenAI Code (Codex) subscription OAuth** को पूरी तरह सपोर्ट करता है। onboarding wizard
आपके लिए OAuth flow चला सकता है।

देखें [OAuth](/concepts/oauth), [Model providers](/concepts/model-providers), और [Wizard](/start/wizard)।

### मैं Gemini CLI OAuth कैसे सेट करूँ

Gemini CLI एक **plugin auth flow** का उपयोग करता है, न कि `openclaw.json` में client id या secret।

कदम:

1. प्लगइन सक्षम करें: `openclaw plugins enable google-gemini-cli-auth`
2. लॉगिन: `openclaw models auth login --provider google-gemini-cli --set-default`

यह gateway host पर auth profiles में OAuth टोकन स्टोर करता है। विवरण: [Model providers](/concepts/model-providers)।

### क्या casual chats के लिए local model ठीक है

आमतौर पर नहीं। OpenClaw को बड़ा context + मजबूत safety चाहिए; छोटे कार्ड truncate करते हैं और leak करते हैं। यदि मजबूरी हो, तो locally (LM Studio) **सबसे बड़ा** MiniMax M2.1 build चलाएँ और [/gateway/local-models](/gateway/local-models) देखें। छोटे/quantized models prompt-injection जोखिम बढ़ाते हैं - देखें [Security](/gateway/security)।

### मैं hosted model traffic को किसी विशेष region में कैसे रखूँ

region-pinned endpoints चुनें। OpenRouter MiniMax, Kimi, और GLM के लिए US-hosted विकल्प उपलब्ध कराता है; डेटा को region में रखने के लिए US-hosted variant चुनें। 1. आप `models.mode: "merge"` का उपयोग करके इनके साथ Anthropic/OpenAI को अभी भी सूचीबद्ध कर सकते हैं, ताकि आपके द्वारा चुने गए क्षेत्र-आधारित प्रदाता का सम्मान करते हुए फॉलबैक उपलब्ध रहें।

### 2. क्या मुझे इसे इंस्टॉल करने के लिए Mac Mini खरीदना होगा

3. नहीं। 4. OpenClaw macOS या Linux पर चलता है (Windows पर WSL2 के माध्यम से)। 5. Mac mini वैकल्पिक है - कुछ लोग इसे हमेशा‑चालू होस्ट के रूप में खरीदते हैं, लेकिन एक छोटा VPS, होम सर्वर, या Raspberry Pi‑क्लास बॉक्स भी काम करता है।

6. आपको **macOS‑only टूल्स** के लिए ही Mac की आवश्यकता होती है। 7. iMessage के लिए, [BlueBubbles](/channels/bluebubbles) का उपयोग करें (अनुशंसित) - BlueBubbles सर्वर किसी भी Mac पर चलता है, और Gateway Linux या कहीं और चल सकता है। 8. यदि आप अन्य macOS‑only टूल्स चाहते हैं, तो Gateway को Mac पर चलाएँ या किसी macOS नोड के साथ पेयर करें।

9. Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes), [Mac remote mode](/platforms/mac/remote)।

### 10. क्या iMessage सपोर्ट के लिए मुझे Mac mini चाहिए

11. आपको Messages में साइन‑इन किया हुआ **कोई macOS डिवाइस** चाहिए। 12. यह **ज़रूरी नहीं** है कि वह Mac mini ही हो - कोई भी Mac काम करता है। 13. iMessage के लिए **[BlueBubbles](/channels/bluebubbles)** (अनुशंसित) का उपयोग करें - BlueBubbles सर्वर macOS पर चलता है, जबकि Gateway Linux या कहीं और चल सकता है।

14. सामान्य सेटअप:

- 15. Gateway को Linux/VPS पर चलाएँ, और BlueBubbles सर्वर को Messages में साइन‑इन किए हुए किसी भी Mac पर चलाएँ।
- 16. यदि आप सबसे सरल सिंगल‑मशीन सेटअप चाहते हैं, तो सब कुछ Mac पर ही चलाएँ।

17. Docs: [BlueBubbles](/channels/bluebubbles), [Nodes](/nodes),
    [Mac remote mode](/platforms/mac/remote)।

### 18. यदि मैं OpenClaw चलाने के लिए Mac mini खरीदूँ, तो क्या मैं इसे अपने MacBook Pro से कनेक्ट कर सकता हूँ

हाँ। 20. **Mac mini Gateway चला सकता है**, और आपका MacBook Pro एक **node** (कम्पैनियन डिवाइस) के रूप में कनेक्ट हो सकता है। 21. Nodes Gateway नहीं चलाते - वे उस डिवाइस पर स्क्रीन/कैमरा/कैनवास और `system.run` जैसी अतिरिक्त क्षमताएँ प्रदान करते हैं।

सामान्य पैटर्न:

- 23. Mac mini पर Gateway (हमेशा‑चालू)।
- 24. MacBook Pro macOS ऐप या एक node host चलाता है और Gateway से पेयर करता है।
- 25. इसे देखने के लिए `openclaw nodes status` / `openclaw nodes list` का उपयोग करें।

डॉक्स: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### 26. क्या मैं Bun का उपयोग कर सकता हूँ

27. Bun **अनुशंसित नहीं** है। 28. हमें रनटाइम बग दिखाई देते हैं, खासकर WhatsApp और Telegram के साथ।
28. स्थिर Gateway के लिए **Node** का उपयोग करें।

30. यदि आप फिर भी Bun के साथ प्रयोग करना चाहते हैं, तो इसे किसी non‑production Gateway पर करें
    जिसमें WhatsApp/Telegram न हों।

### 31. Telegram में allowFrom में क्या जाता है

32. `channels.telegram.allowFrom` **मानव प्रेषक का Telegram user ID** होता है (संख्यात्मक, अनुशंसित) या `@username`। 33. यह बॉट का यूज़रनेम नहीं है।

अधिक सुरक्षित (कोई third-party बॉट नहीं):

- 34. अपने बॉट को DM करें, फिर `openclaw logs --follow` चलाएँ और `from.id` पढ़ें।

35. आधिकारिक Bot API:

- 36. अपने बॉट को DM करें, फिर `https://api.telegram.org/bot<bot_token>/getUpdates` कॉल करें और `message.from.id` पढ़ें।

Third-party (कम निजी):

- `@userinfobot` या `@getidsbot` को DM करें।

38. देखें [/channels/telegram](/channels/telegram#access-control-dms--groups)।

### 39. क्या कई लोग एक ही WhatsApp नंबर को अलग‑अलग OpenClaw इंस्टेंस के साथ उपयोग कर सकते हैं

40. हाँ, **multi‑agent routing** के माध्यम से। 41. प्रत्येक प्रेषक के WhatsApp **DM** (peer `kind: "dm"`, प्रेषक E.164 जैसे `+15551234567`) को अलग `agentId` से बाँधें, ताकि हर व्यक्ति को अपना अलग workspace और session store मिले। उत्तर अब भी **उसी WhatsApp अकाउंट** से आते हैं, और DM एक्सेस कंट्रोल (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) प्रति WhatsApp अकाउंट वैश्विक होता है। 43. देखें [Multi-Agent Routing](/concepts/multi-agent) और [WhatsApp](/channels/whatsapp)।

### 44. क्या मैं एक तेज़ chat agent और coding के लिए एक Opus agent चला सकता हूँ

45. हाँ। 46. multi‑agent routing का उपयोग करें: हर agent को उसका अपना default model दें, फिर inbound routes (provider account या specific peers) को प्रत्येक agent से बाँधें। 47. उदाहरण कॉन्फ़िग [Multi-Agent Routing](/concepts/multi-agent) में मौजूद है। 48. साथ ही देखें [Models](/concepts/models) और [Configuration](/gateway/configuration)।

### 49. क्या Homebrew Linux पर काम करता है

50. हाँ। Homebrew Linux (Linuxbrew) को सपोर्ट करता है। Quick setup:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

यदि आप OpenClaw को systemd के माध्यम से चलाते हैं, तो सुनिश्चित करें कि सेवा PATH में `/home/linuxbrew/.linuxbrew/bin` (या आपका brew प्रीफ़िक्स) शामिल हो ताकि `brew` से इंस्टॉल किए गए टूल नॉन-लॉगिन शेल्स में भी रेज़ॉल्व हों।
हाल की बिल्ड्स Linux systemd सेवाओं में सामान्य यूज़र bin डायरेक्टरीज़ भी प्रीपेंड करती हैं (उदाहरण के लिए `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) और `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, और `FNM_DIR` को सेट होने पर सम्मान देती हैं।

### हैक करने योग्य git इंस्टॉल और npm इंस्टॉल में क्या अंतर है

- **Hackable (git) install:** full source checkout, editable, best for contributors.
  आप बिल्ड्स लोकली चलाते हैं और कोड/डॉक्स में पैच कर सकते हैं।
- **npm install:** global CLI install, no repo, best for "just run it."
  Updates come from npm dist-tags.

Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

### Can I switch between npm and git installs later

Yes. दूसरा फ्लेवर इंस्टॉल करें, फिर Doctor चलाएँ ताकि gateway सेवा नए एंट्रीपॉइंट की ओर इशारा करे।
This **does not delete your data** - it only changes the OpenClaw code install. आपका स्टेट
(`~/.openclaw`) और वर्कस्पेस (`~/.openclaw/workspace`) अप्रभावित रहते हैं।

From npm → git:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
openclaw doctor
openclaw gateway restart
```

From git → npm:

```bash
npm install -g openclaw@latest
openclaw doctor
openclaw gateway restart
```

Doctor gateway सेवा के एंट्रीपॉइंट में असंगति का पता लगाता है और वर्तमान इंस्टॉल से मेल कराने के लिए सेवा कॉन्फ़िग को फिर से लिखने का प्रस्ताव देता है (ऑटोमेशन में `--repair` का उपयोग करें)।

Backup tips: see [Backup strategy](/help/faq#whats-the-recommended-backup-strategy).

### क्या मुझे Gateway अपने लैपटॉप पर चलाना चाहिए या VPS पर

संक्षिप्त उत्तर: **यदि आप 24/7 विश्वसनीयता चाहते हैं, तो VPS का उपयोग करें**। If you want the
lowest friction and you're okay with sleep/restarts, run it locally.

**Laptop (local Gateway)**

- **फ़ायदे:** सर्वर लागत नहीं, लोकल फ़ाइलों तक सीधी पहुँच, लाइव ब्राउज़र विंडो।
- **नुकसान:** स्लीप/नेटवर्क ड्रॉप = डिसकनेक्ट, OS अपडेट/रीबूट में बाधा, जागृत रहना ज़रूरी।

**VPS / cloud**

- **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
- **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.

**OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord all work fine from a VPS. The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).

**Recommended default:** VPS if you had gateway disconnects before. Local is great when you're actively using the Mac and want local file access or UI automation with a visible browser.

### How important is it to run OpenClaw on a dedicated machine

आवश्यक नहीं, लेकिन **विश्वसनीयता और आइसोलेशन के लिए अनुशंसित**।

- **Dedicated host (VPS/Mac mini/Pi):** always-on, fewer sleep/reboot interruptions, cleaner permissions, easier to keep running.
- **Shared laptop/desktop:** totally fine for testing and active use, but expect pauses when the machine sleeps or updates.

If you want the best of both worlds, keep the Gateway on a dedicated host and pair your laptop as a **node** for local screen/camera/exec tools. See [Nodes](/nodes).
For security guidance, read [Security](/gateway/security).

### What are the minimum VPS requirements and recommended OS

OpenClaw is lightweight. For a basic Gateway + one chat channel:

- **Absolute minimum:** 1 vCPU, 1GB RAM, ~500MB disk.
- **Recommended:** 1-2 vCPU, 2GB RAM or more for headroom (logs, media, multiple channels). Node tools and browser automation can be resource hungry.

OS: use **Ubuntu LTS** (or any modern Debian/Ubuntu). The Linux install path is best tested there.

Docs: [Linux](/platforms/linux), [VPS hosting](/vps).

### क्या मैं OpenClaw को VM में चला सकता हूँ और इसकी क्या आवश्यकताएँ हैं

हाँ। VM को VPS की तरह ही मानें: यह हमेशा चालू रहना चाहिए, पहुँच योग्य होना चाहिए, और Gateway तथा आपके द्वारा सक्षम किए गए किसी भी चैनल के लिए पर्याप्त RAM होनी चाहिए।

बेसलाइन मार्गदर्शन:

- **न्यूनतम आवश्यकता:** 1 vCPU, 1GB RAM।
- **अनुशंसित:** 2GB RAM या उससे अधिक, यदि आप कई चैनल, ब्राउज़र ऑटोमेशन, या मीडिया टूल्स चलाते हैं।
- **OS:** Ubuntu LTS या कोई अन्य आधुनिक Debian/Ubuntu।

यदि आप Windows पर हैं, तो **WSL2 सबसे आसान VM-शैली का सेटअप है** और इसमें सर्वोत्तम टूलिंग संगतता है। देखें [Windows](/platforms/windows), [VPS hosting](/vps).
यदि आप VM में macOS चला रहे हैं, तो [macOS VM](/install/macos-vm) देखें।

## OpenClaw क्या है?

### एक पैराग्राफ में OpenClaw क्या है

OpenClaw एक व्यक्तिगत AI सहायक है जिसे आप अपने स्वयं के डिवाइस पर चलाते हैं। यह उन मैसेजिंग प्लेटफ़ॉर्म पर जवाब देता है जिन्हें आप पहले से उपयोग करते हैं (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) और समर्थित प्लेटफ़ॉर्म पर वॉइस + लाइव Canvas भी प्रदान करता है। **Gateway** हमेशा चालू रहने वाला कंट्रोल प्लेन है; सहायक ही प्रोडक्ट है।

### वैल्यू प्रपोज़िशन क्या है

OpenClaw "सिर्फ़ एक Claude रैपर" नहीं है। यह एक **local-first control plane** है जो आपको **अपने स्वयं के हार्डवेयर** पर एक सक्षम सहायक चलाने देता है, जिसे उन चैट ऐप्स से एक्सेस किया जा सकता है जिन्हें आप पहले से उपयोग करते हैं, साथ ही stateful sessions, memory, और tools के साथ — बिना अपने वर्कफ़्लो का नियंत्रण किसी होस्टेड SaaS को सौंपे।

हाइलाइट्स:

- **आपके डिवाइस, आपका डेटा:** Gateway को जहाँ चाहें चलाएँ (Mac, Linux, VPS) और workspace + session history को स्थानीय रखें।
- **वास्तविक चैनल, न कि वेब सैंडबॉक्स:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc, साथ ही समर्थित प्लेटफ़ॉर्म पर मोबाइल वॉइस और Canvas।
- **Model-agnostic:** Anthropic, OpenAI, MiniMax, OpenRouter आदि का उपयोग करें, प्रति-एजेंट रूटिंग और failover के साथ।
- **Local-only विकल्प:** यदि आप चाहें तो local models चलाएँ ताकि **सारा डेटा आपके डिवाइस पर ही रहे**।
- **Multi-agent routing:** प्रति चैनल, अकाउंट, या कार्य के लिए अलग-अलग एजेंट, प्रत्येक का अपना workspace और defaults।
- **ओपन सोर्स और हैक करने योग्य:** बिना वेंडर लॉक-इन के निरीक्षण करें, विस्तार करें और सेल्फ-होस्ट करें।

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### मैंने अभी इसे सेटअप किया है, सबसे पहले मुझे क्या करना चाहिए

अच्छे पहले प्रोजेक्ट्स:

- एक वेबसाइट बनाना (WordPress, Shopify, या एक साधारण static site)।
- एक मोबाइल ऐप का प्रोटोटाइप बनाना (आउटलाइन, स्क्रीन, API प्लान)।
- फ़ाइलों और फ़ोल्डरों को व्यवस्थित करना (क्लीनअप, नामकरण, टैगिंग)।
- Gmail कनेक्ट करें और summaries या follow-ups को ऑटोमेट करें।

यह बड़े कार्य संभाल सकता है, लेकिन यह सबसे अच्छा तब काम करता है जब आप उन्हें चरणों में विभाजित करें और समानांतर कार्य के लिए sub agents का उपयोग करें।

### OpenClaw के रोज़मर्रा के शीर्ष पाँच उपयोग मामले क्या हैं

रोज़मर्रा की जीतें आमतौर पर इस तरह दिखती हैं:

- **Personal briefings:** आपके इनबॉक्स, कैलेंडर, और आपकी रुचि की खबरों का सारांश।
- **Research and drafting:** ईमेल या डॉक्यूमेंट्स के लिए त्वरित रिसर्च, सारांश, और शुरुआती ड्राफ्ट।
- **Reminders and follow ups:** cron या heartbeat आधारित रिमाइंडर और चेकलिस्ट।
- **Browser automation:** फ़ॉर्म भरना, डेटा एकत्र करना, और दोहराए जाने वाले वेब कार्य।
- **Cross device coordination:** अपने फ़ोन से कोई कार्य भेजें, Gateway को सर्वर पर उसे चलाने दें, और परिणाम चैट में वापस पाएँ।

### क्या OpenClaw SaaS के लिए lead gen, outreach, ads और blogs में मदद कर सकता है

**Research, qualification, और drafting** के लिए हाँ। यह साइट्स स्कैन कर सकता है, shortlists बना सकता है, prospects का सारांश कर सकता है, और outreach या ad copy के ड्राफ्ट लिख सकता है।

**Outreach या ad runs** के लिए, एक इंसान को प्रक्रिया में रखें। स्पैम से बचें, स्थानीय क़ानूनों और प्लेटफ़ॉर्म नीतियों का पालन करें, और भेजने से पहले हर चीज़ की समीक्षा करें। सबसे सुरक्षित पैटर्न यह है कि OpenClaw ड्राफ्ट करे और आप उसे अनुमोदित करें।

Docs: [Security](/gateway/security).

### वेब डेवलपमेंट के लिए Claude Code की तुलना में क्या फायदे हैं

OpenClaw एक **personal assistant** और coordination layer है, IDE का विकल्प नहीं। रिपॉज़िटरी के भीतर सबसे तेज़ सीधे coding loop के लिए Claude Code या Codex का उपयोग करें। जब आपको durable memory, cross-device access, और tool orchestration चाहिए, तब OpenClaw का उपयोग करें।

1. लाभ:

- 2. **स्थायी मेमोरी + वर्कस्पेस** सत्रों के बीच
- 3. **मल्टी-प्लेटफ़ॉर्म एक्सेस** (WhatsApp, Telegram, TUI, WebChat)
- 4. **टूल ऑर्केस्ट्रेशन** (ब्राउज़र, फ़ाइलें, शेड्यूलिंग, हुक्स)
- 5. **ऑलवेज़-ऑन गेटवे** (VPS पर चलाएँ, कहीं से भी इंटरैक्ट करें)
- 6. लोकल ब्राउज़र/स्क्रीन/कैमरा/exec के लिए **नोड्स**

7. शोकेस: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## 8. स्किल्स और ऑटोमेशन

### 9. मैं रिपॉज़िटरी को गंदा किए बिना स्किल्स को कैसे कस्टमाइज़ करूँ

10. रिपॉज़िटरी कॉपी को एडिट करने के बजाय मैनेज्ड ओवरराइड्स का उपयोग करें। 11. अपने बदलाव `~/.openclaw/skills/<name>/SKILL.md` में रखें (या `~/.openclaw/openclaw.json` में `skills.load.extraDirs` के ज़रिए एक फ़ोल्डर जोड़ें)। 12. प्राथमिकता `<workspace>/skills` > `~/.openclaw/skills` > bundled होती है, इसलिए मैनेज्ड ओवरराइड्स git को छुए बिना जीतते हैं। 13. केवल वे एडिट्स जो upstream के योग्य हों, रिपॉज़िटरी में होने चाहिए और PRs के रूप में भेजे जाने चाहिए।

### 14. क्या मैं किसी कस्टम फ़ोल्डर से स्किल्स लोड कर सकता हूँ

15. हाँ। 16. `~/.openclaw/openclaw.json` में `skills.load.extraDirs` के माध्यम से अतिरिक्त डायरेक्टरीज़ जोड़ें (सबसे कम प्राथमिकता)। डिफ़ॉल्ट प्रायोरिटी बनी रहती है: `<workspace>/skills` → `~/.openclaw/skills` → बंडल्ड → `skills.load.extraDirs`। 18. `clawhub` डिफ़ॉल्ट रूप से `./skills` में इंस्टॉल करता है, जिसे OpenClaw `<workspace>/skills` मानता है।

### 19. मैं अलग-अलग कार्यों के लिए अलग-अलग मॉडल कैसे उपयोग कर सकता हूँ

20. आज समर्थित पैटर्न ये हैं:

- 21. **Cron jobs**: अलग-थलग जॉब्स प्रति जॉब `model` ओवरराइड सेट कर सकते हैं।
- 22. **Sub-agents**: अलग-अलग डिफ़ॉल्ट मॉडल वाले अलग एजेंट्स की ओर कार्यों को रूट करें।
- 23. **On-demand switch**: वर्तमान सत्र मॉडल को किसी भी समय बदलने के लिए `/model` का उपयोग करें।

24. देखें [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), और [Slash commands](/tools/slash-commands)।

### 25. भारी काम करते समय बॉट फ्रीज़ हो जाता है — मैं उसे कैसे ऑफ़लोड करूँ

26. लंबे या समानांतर कार्यों के लिए **sub-agents** का उपयोग करें। 27. Sub-agents अपने अलग सत्र में चलते हैं,
    एक सारांश लौटाते हैं, और आपकी मुख्य चैट को उत्तरदायी रखते हैं।

28. अपने बॉट से कहें "इस कार्य के लिए एक sub-agent स्पॉन करें" या `/subagents` का उपयोग करें।
29. अभी गेटवे क्या कर रहा है (और क्या वह व्यस्त है) यह देखने के लिए चैट में `/status` का उपयोग करें।

30. टोकन टिप: लंबे कार्य और sub-agents दोनों टोकन खर्च करते हैं। 31. यदि लागत चिंता का विषय है, तो
    `agents.defaults.subagents.model` के माध्यम से sub-agents के लिए एक सस्ता मॉडल सेट करें।

32. डॉक्युमेंट्स: [Sub-agents](/tools/subagents)।

### 33. Cron या रिमाइंडर्स नहीं चल रहे — मुझे क्या जाँचना चाहिए

34. Cron गेटवे प्रोसेस के अंदर चलता है। 35. यदि गेटवे लगातार नहीं चल रहा है,
    तो शेड्यूल्ड जॉब्स नहीं चलेंगे।

चेकलिस्ट:

- 36. पुष्टि करें कि cron सक्षम है (`cron.enabled`) और `OPENCLAW_SKIP_CRON` सेट नहीं है।
- 37. जाँचें कि गेटवे 24/7 चल रहा है (कोई स्लीप/रीस्टार्ट नहीं)।
- 38. जॉब के लिए टाइमज़ोन सेटिंग्स सत्यापित करें (`--tz` बनाम होस्ट टाइमज़ोन)।

39. डिबग:

```bash
40. openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

41. डॉक्युमेंट्स: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat)।

### 42. मैं Linux पर स्किल्स कैसे इंस्टॉल करूँ

43. **ClawHub** (CLI) का उपयोग करें या स्किल्स को अपने वर्कस्पेस में डाल दें। 44. macOS Skills UI Linux पर उपलब्ध नहीं है।
44. स्किल्स ब्राउज़ करें: [https://clawhub.com](https://clawhub.com)।

46. ClawHub CLI इंस्टॉल करें (किसी एक पैकेज मैनेजर को चुनें):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### 47. क्या OpenClaw निर्धारित समय पर या बैकग्राउंड में लगातार कार्य चला सकता है

48. हाँ। 49. गेटवे शेड्यूलर का उपयोग करें:

- 50. **Cron jobs** निर्धारित या आवर्ती कार्यों के लिए (रीस्टार्ट्स के बाद भी बने रहते हैं)।
- **Heartbeat** "main session" के लिए आवधिक जाँच।
- **Isolated jobs** स्वायत्त एजेंट्स के लिए, जो सारांश पोस्ट करते हैं या चैट्स में डिलीवर करते हैं।

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### क्या मैं Linux से केवल Apple macOS-के लिए बने स्किल्स चला सकता हूँ?

सीधे तौर पर नहीं। macOS स्किल्स `metadata.openclaw.os` और आवश्यक बाइनरीज़ द्वारा नियंत्रित होते हैं, और स्किल्स केवल तभी सिस्टम प्रॉम्प्ट में दिखाई देते हैं जब वे **Gateway host** पर पात्र हों। Linux पर, `darwin`-only स्किल्स (जैसे `apple-notes`, `apple-reminders`, `things-mac`) तब तक लोड नहीं होंगे जब तक आप gating को ओवरराइड नहीं करते।

आपके पास तीन समर्थित पैटर्न हैं:

**Option A - Gateway को Mac पर चलाएँ (सबसे सरल)।**
Gateway को वहाँ चलाएँ जहाँ macOS बाइनरीज़ मौजूद हों, फिर Linux से [remote mode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) में या Tailscale के माध्यम से कनेक्ट करें। Gateway host macOS होने के कारण स्किल्स सामान्य रूप से लोड होते हैं।

**Option B - macOS node का उपयोग करें (SSH नहीं)।**
Gateway को Linux पर चलाएँ, एक macOS node (मेनूबार ऐप) को पेयर करें, और Mac पर **Node Run Commands** को "Always Ask" या "Always Allow" पर सेट करें। जब आवश्यक बाइनरीज़ node पर मौजूद हों, तो OpenClaw macOS-only स्किल्स को पात्र मान सकता है। एजेंट उन स्किल्स को `nodes` टूल के माध्यम से चलाता है। यदि आप "Always Ask" चुनते हैं, तो प्रॉम्प्ट में "Always Allow" को स्वीकृत करने से वह कमांड allowlist में जुड़ जाती है।

**Option C - SSH के माध्यम से macOS बाइनरीज़ को प्रॉक्सी करें (उन्नत)।**
Gateway को Linux पर रखें, लेकिन आवश्यक CLI बाइनरीज़ को ऐसे SSH रैपर्स से resolve कराएँ जो Mac पर चलते हों। फिर स्किल को ओवरराइड करें ताकि Linux की अनुमति हो और वह पात्र बना रहे।

1. बाइनरी के लिए एक SSH रैपर बनाएँ (उदाहरण: Apple Notes के लिए `memo`):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Linux होस्ट पर रैपर को `PATH` में रखें (उदाहरण के लिए `~/bin/memo`)।

3. Linux की अनुमति देने के लिए स्किल metadata (workspace या `~/.openclaw/skills`) को ओवरराइड करें:

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. एक नया सत्र शुरू करें ताकि स्किल्स स्नैपशॉट रिफ्रेश हो जाए।

### क्या आपके पास Notion या HeyGen इंटीग्रेशन है

आज के लिए बिल्ट-इन नहीं है।

विकल्प:

- **Custom skill / plugin:** विश्वसनीय API एक्सेस के लिए सबसे बेहतर (Notion/HeyGen दोनों के पास APIs हैं)।
- **Browser automation:** बिना कोड के काम करता है, लेकिन धीमा और अधिक नाज़ुक होता है।

यदि आप प्रति क्लाइंट संदर्भ बनाए रखना चाहते हैं (एजेंसी वर्कफ़्लो), तो एक सरल पैटर्न है:

- प्रति क्लाइंट एक Notion पेज (संदर्भ + प्राथमिकताएँ + सक्रिय कार्य)।
- सत्र की शुरुआत में एजेंट से उस पेज को फ़ेच करने को कहें।

यदि आप एक नेटिव इंटीग्रेशन चाहते हैं, तो फ़ीचर रिक्वेस्ट खोलें या उन APIs को लक्षित करते हुए एक स्किल बनाएँ।

Install skills:

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub आपके वर्तमान डायरेक्टरी के अंतर्गत `./skills` में इंस्टॉल करता है (या आपके कॉन्फ़िगर किए गए OpenClaw workspace पर फ़ॉलबैक करता है); अगली सत्र में OpenClaw इसे `<workspace>/skills` के रूप में मानता है। एजेंट्स के बीच साझा स्किल्स के लिए, उन्हें `~/.openclaw/skills/<name>/SKILL.md` में रखें। कुछ स्किल्स Homebrew के माध्यम से इंस्टॉल की गई बाइनरीज़ की अपेक्षा करते हैं; Linux पर इसका मतलब Linuxbrew है (ऊपर दिए गए Homebrew Linux FAQ एंट्री देखें)। देखें [Skills](/tools/skills) और [ClawHub](/tools/clawhub)।

### ब्राउज़र टेकओवर के लिए Chrome एक्सटेंशन कैसे इंस्टॉल करूँ

बिल्ट-इन इंस्टॉलर का उपयोग करें, फिर Chrome में अनपैक्ड एक्सटेंशन लोड करें:

```bash
openclaw browser extension install
openclaw browser extension path
```

फिर Chrome → `chrome://extensions` → "Developer mode" सक्षम करें → "Load unpacked" → उस फ़ोल्डर को चुनें।

पूर्ण गाइड (remote Gateway + सुरक्षा नोट्स सहित): [Chrome extension](/tools/chrome-extension)

यदि Gateway उसी मशीन पर चलता है जिस पर Chrome है (डिफ़ॉल्ट सेटअप), तो आमतौर पर आपको कुछ अतिरिक्त की **ज़रूरत नहीं** होती।
यदि Gateway कहीं और चलता है, तो ब्राउज़र मशीन पर node होस्ट चलाएँ ताकि Gateway ब्राउज़र क्रियाओं को प्रॉक्सी कर सके।
फिर भी आपको उस टैब पर एक्सटेंशन बटन क्लिक करना होगा जिसे आप नियंत्रित करना चाहते हैं (यह अपने आप अटैच नहीं होता)।

## Sandboxing और मेमोरी

### क्या sandboxing के लिए कोई समर्पित डॉक है

हाँ। देखें [Sandboxing](/gateway/sandboxing)। Docker-विशिष्ट सेटअप के लिए (Docker में पूर्ण gateway या sandbox images), देखें [Docker](/install/docker)।

### Docker सीमित लगता है। मैं पूर्ण फीचर्स कैसे सक्षम करूँ

डिफ़ॉल्ट इमेज सुरक्षा-प्रथम है और `node` यूज़र के रूप में चलती है, इसलिए इसमें सिस्टम पैकेज, Homebrew, या बंडल्ड ब्राउज़र्स शामिल नहीं होते। और अधिक पूर्ण सेटअप के लिए:

- Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.
- Bake system deps into the image with `OPENCLAW_DOCKER_APT_PACKAGES`.
- Install Playwright browsers via the bundled CLI:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- Set `PLAYWRIGHT_BROWSERS_PATH` and ensure the path is persisted.

डॉक्स: [Docker](/install/docker), [Browser](/tools/browser)।

**Can I keep DMs personal but make groups public sandboxed with one agent**

Yes - if your private traffic is **DMs** and your public traffic is **groups**.

Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. Then restrict what tools are available in sandboxed sessions via `tools.sandbox.tools`.

Setup walkthrough + example config: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Key config reference: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### How do I bind a host folder into the sandbox

Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls. उदाहरणों और सुरक्षा नोट्स के लिए [Sandboxing](/gateway/sandboxing#custom-bind-mounts) और [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) देखें।

### How does memory work

OpenClaw की मेमोरी एजेंट वर्कस्पेस में मौजूद सिर्फ़ Markdown फ़ाइलें होती हैं:

- Daily notes in `memory/YYYY-MM-DD.md`
- Curated long-term notes in `MEMORY.md` (main/private sessions only)

OpenClaw also runs a **silent pre-compaction memory flush** to remind the model
to write durable notes before auto-compaction. This only runs when the workspace
is writable (read-only sandboxes skip it). देखें [Memory](/concepts/memory)।

### Memory keeps forgetting things How do I make it stick

Ask the bot to **write the fact to memory**. Long-term notes belong in `MEMORY.md`,
short-term context goes into `memory/YYYY-MM-DD.md`.

This is still an area we are improving. It helps to remind the model to store memories;
it will know what to do. अगर यह बार-बार भूल रहा है, तो जाँचें कि Gateway हर रन में वही वर्कस्पेस इस्तेमाल कर रहा है।

Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

### Does semantic memory search require an OpenAI API key

Only if you use **OpenAI embeddings**. Codex OAuth covers chat/completions and
does **not** grant embeddings access, so **signing in with Codex (OAuth or the
Codex CLI login)** does not help for semantic memory search. OpenAI embeddings
still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

अगर आप किसी provider को स्पष्ट रूप से सेट नहीं करते हैं, तो OpenClaw तब अपने-आप provider चुन लेता है जब वह किसी API key को resolve कर पाता है (auth profiles, `models.providers.*.apiKey`, या env vars)।
It prefers OpenAI if an OpenAI key resolves, otherwise Gemini if a Gemini key
resolves. If neither key is available, memory search stays disabled until you
configure it. If you have a local model path configured and present, OpenClaw
prefers `local`.

If you'd rather stay local, set `memorySearch.provider = "local"` (and optionally
`memorySearch.fallback = "none"`). If you want Gemini embeddings, set
`memorySearch.provider = "gemini"` and provide `GEMINI_API_KEY` (or
`memorySearch.remote.apiKey`). We support **OpenAI, Gemini, or local** embedding
models - see [Memory](/concepts/memory) for the setup details.

### Does memory persist forever What are the limits

Memory files live on disk and persist until you delete them. The limit is your
storage, not the model. The **session context** is still limited by the model
context window, so long conversations can compact or truncate. That is why
memory search exists - it pulls only the relevant parts back into context.

Docs: [Memory](/concepts/memory), [Context](/concepts/context).

## Where things live on disk

### Is all data used with OpenClaw saved locally

No - **OpenClaw's state is local**, but **external services still see what you send them**.

- **Local by default:** sessions, memory files, config, and workspace live on the Gateway host
  (`~/.openclaw` + your workspace directory).
- **Remote by necessity:** messages you send to model providers (Anthropic/OpenAI/etc.) go to
  their APIs, and chat platforms (WhatsApp/Telegram/Slack/etc.) store message data on their
  servers.
- **You control the footprint:** using local models keeps prompts on your machine, but channel
  traffic still goes through the channel's servers.

Related: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

### Where does OpenClaw store its data

Everything lives under `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`):

| Path                                                            | उद्देश्य                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | Main config (JSON5)                                                                     |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Legacy OAuth import (copied into auth profiles on first use)                            |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profiles (OAuth + API keys)                                                        |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Runtime auth cache (managed automatically)                                              |
| `$OPENCLAW_STATE_DIR/credentials/`                              | Provider state (e.g. `whatsapp/<accountId>/creds.json`) |
| `$OPENCLAW_STATE_DIR/agents/`                                   | Per-agent state (agentDir + sessions)                                                   |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Conversation history & state (per agent)                            |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Session metadata (per agent)                                                            |

Legacy single-agent path: `~/.openclaw/agent/*` (migrated by `openclaw doctor`).

Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate and configured via `agents.defaults.workspace` (default: `~/.openclaw/workspace`).

### Where should AGENTSmd SOULmd USERmd MEMORYmd live

These files live in the **agent workspace**, not `~/.openclaw`.

- **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md` (or `memory.md`), `memory/YYYY-MM-DD.md`, optional `HEARTBEAT.md`.
- **State dir (`~/.openclaw`)**: config, credentials, auth profiles, sessions, logs,
  and shared skills (`~/.openclaw/skills`).

Default workspace is `~/.openclaw/workspace`, configurable via:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

If the bot "forgets" after a restart, confirm the Gateway is using the same
workspace on every launch (and remember: remote mode uses the **gateway host's**
workspace, not your local laptop).

Tip: if you want a durable behavior or preference, ask the bot to **write it into
AGENTS.md or MEMORY.md** rather than relying on chat history.

See [Agent workspace](/concepts/agent-workspace) and [Memory](/concepts/memory).

### What's the recommended backup strategy

Put your **agent workspace** in a **private** git repo and back it up somewhere
private (for example GitHub private). This captures memory + AGENTS/SOUL/USER
files, and lets you restore the assistant's "mind" later.

Do **not** commit anything under `~/.openclaw` (credentials, sessions, tokens).
If you need a full restore, back up both the workspace and the state directory
separately (see the migration question above).

Docs: [Agent workspace](/concepts/agent-workspace).

### How do I completely uninstall OpenClaw

See the dedicated guide: [Uninstall](/install/uninstall).

### Can agents work outside the workspace

Yes. The workspace is the **default cwd** and memory anchor, not a hard sandbox.
Relative paths resolve inside the workspace, but absolute paths can access other
host locations unless sandboxing is enabled. If you need isolation, use
[`agents.defaults.sandbox`](/gateway/sandboxing) or per-agent sandbox settings. If you
want a repo to be the default working directory, point that agent's
`workspace` to the repo root. The OpenClaw repo is just source code; keep the
workspace separate unless you intentionally want the agent to work inside it.

Example (repo as default cwd):

```json5
{
  agents: {
    defaults: {
      workspace: "~/Projects/my-repo",
    },
  },
}
```

### मैं रिमोट मोड में हूँ, सेशन स्टोर कहाँ है

सेशन स्टेट **gateway host** के स्वामित्व में होती है। अगर आप रिमोट मोड में हैं, तो जिस सेशन स्टोर की आपको ज़रूरत है वह रिमोट मशीन पर होता है, आपके लोकल लैपटॉप पर नहीं। देखें [Session management](/concepts/session).

## कॉन्फ़िग की बुनियादी बातें

### कॉन्फ़िग किस फ़ॉर्मैट में है, यह कहाँ है

OpenClaw `$OPENCLAW_CONFIG_PATH` (डिफ़ॉल्ट: `~/.openclaw/openclaw.json`) से एक वैकल्पिक **JSON5** कॉन्फ़िग पढ़ता है:

```
$OPENCLAW_CONFIG_PATH
```

अगर फ़ाइल मौजूद नहीं है, तो यह सुरक्षित-से डिफ़ॉल्ट्स का उपयोग करता है (जिसमें डिफ़ॉल्ट वर्कस्पेस `~/.openclaw/workspace` शामिल है)।

### मैंने gatewaybind को lan या tailnet पर सेट किया और अब कुछ भी सुन नहीं रहा, UI में unauthorized दिखाता है

Non-loopback bind के लिए **auth आवश्यक** है। `gateway.auth.mode` + `gateway.auth.token` कॉन्फ़िगर करें (या `OPENCLAW_GATEWAY_TOKEN` का उपयोग करें)।

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

टिप्पणियाँ:

- `gateway.remote.token` केवल **remote CLI calls** के लिए है; यह लोकल gateway auth को सक्षम नहीं करता।
- Control UI `connect.params.auth.token` के माध्यम से authenticate करता है (जो app/UI settings में संग्रहीत होता है)। URL में टोकन डालने से बचें।

### अब localhost पर मुझे टोकन की ज़रूरत क्यों है

विज़ार्ड डिफ़ॉल्ट रूप से एक gateway टोकन जनरेट करता है (loopback पर भी), इसलिए **लोकल WS क्लाइंट्स को authenticate करना ज़रूरी है**। यह अन्य लोकल प्रोसेसेज़ को Gateway को कॉल करने से रोकता है। कनेक्ट करने के लिए Control UI settings (या अपने क्लाइंट कॉन्फ़िग) में टोकन पेस्ट करें।

अगर आप **वाकई** open loopback चाहते हैं, तो अपने कॉन्फ़िग से `gateway.auth` हटा दें। Doctor किसी भी समय आपके लिए टोकन जनरेट कर सकता है: `openclaw doctor --generate-gateway-token`।

### क्या कॉन्फ़िग बदलने के बाद मुझे रीस्टार्ट करना होगा

Gateway कॉन्फ़िग को मॉनिटर करता है और hot-reload को सपोर्ट करता है:

- `gateway.reload.mode: "hybrid"` (डिफ़ॉल्ट): सुरक्षित बदलावों को तुरंत लागू करता है, महत्वपूर्ण बदलावों के लिए रीस्टार्ट करता है
- `hot`, `restart`, `off` भी सपोर्टेड हैं

### मैं वेब सर्च और वेब फ़ेच कैसे सक्षम करूँ

`web_fetch` बिना API key के काम करता है। `web_search` के लिए Brave Search API key आवश्यक है। **अनुशंसित:** इसे `tools.web.search.apiKey` में स्टोर करने के लिए `openclaw configure --section web` चलाएँ। Environment विकल्प: Gateway प्रोसेस के लिए `BRAVE_API_KEY` सेट करें।

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
      },
      fetch: {
        enabled: true,
      },
    },
  },
}
```

Notes:

- अगर आप allowlists का उपयोग करते हैं, तो `web_search`/`web_fetch` या `group:web` जोड़ें।
- `web_fetch` डिफ़ॉल्ट रूप से सक्षम है (जब तक स्पष्ट रूप से अक्षम न किया जाए)।
- Daemons env vars को `~/.openclaw/.env` (या service environment) से पढ़ते हैं।

Docs: [Web tools](/tools/web).

### मैं अलग-अलग डिवाइसों पर specialized workers के साथ एक केंद्रीय Gateway कैसे चलाऊँ

सामान्य पैटर्न है **एक Gateway** (जैसे Raspberry Pi) + **nodes** और **agents**:

- **Gateway (केंद्रीय):** चैनल्स (Signal/WhatsApp), रूटिंग और सेशन्स का स्वामी होता है।
- **Nodes (डिवाइस):** Macs/iOS/Android peripherals के रूप में कनेक्ट होते हैं और लोकल टूल्स (`system.run`, `canvas`, `camera`) एक्सपोज़ करते हैं।
- **Agents (workers):** विशेष भूमिकाओं के लिए अलग brains/workspaces (जैसे "Hetzner ops", "Personal data")।
- **Sub-agents:** जब आपको parallelism चाहिए, तो मुख्य agent से बैकग्राउंड काम स्पॉन करते हैं।
- **TUI:** Gateway से कनेक्ट करें और agents/सेशन्स स्विच करें।

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### क्या OpenClaw ब्राउज़र headless चल सकता है

हाँ। यह एक कॉन्फ़िग विकल्प है:

```json5
{
  browser: { headless: true },
  agents: {
    defaults: {
      sandbox: { browser: { headless: true } },
    },
  },
}
```

डिफ़ॉल्ट `false` (headful) है। Headless मोड कुछ साइट्स पर anti-bot चेक्स को ट्रिगर करने की अधिक संभावना रखता है। देखें [Browser](/tools/browser).

2. मुख्य अंतर: 3. कोई दिखाई देने वाली ब्राउज़र विंडो नहीं (यदि विज़ुअल चाहिए तो स्क्रीनशॉट का उपयोग करें)।

- 4. कुछ साइटें headless मोड में ऑटोमेशन के प्रति अधिक सख़्त होती हैं (CAPTCHA, एंटी-बॉट)।
- 5. उदाहरण के लिए, X/Twitter अक्सर headless सेशन को ब्लॉक कर देता है।
  6. मैं ब्राउज़र नियंत्रण के लिए Brave का उपयोग कैसे करूँ

### 7. `browser.executablePath` को अपने Brave बाइनरी (या किसी भी Chromium-आधारित ब्राउज़र) पर सेट करें और Gateway को रीस्टार्ट करें।

8. पूर्ण कॉन्फ़िग उदाहरण देखें: [Browser](/tools/browser#use-brave-or-another-chromium-based-browser)।
9. रिमोट गेटवे और नोड्स

## 10. Telegram, गेटवे और नोड्स के बीच कमांड कैसे प्रोपेगेट होते हैं

### 11. Telegram संदेशों को **gateway** संभालता है।

12. गेटवे एजेंट चलाता है और
    केवल तभी **Gateway WebSocket** के माध्यम से नोड्स को कॉल करता है जब किसी नोड टूल की आवश्यकता होती है: 13. Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

14. नोड्स इनबाउंड प्रोवाइडर ट्रैफ़िक नहीं देखते; उन्हें केवल node RPC कॉल्स मिलती हैं।

15. यदि Gateway रिमोट होस्ट पर होस्टेड है तो मेरा एजेंट मेरे कंप्यूटर तक कैसे पहुँचे

### 16. संक्षिप्त उत्तर: **अपने कंप्यूटर को एक नोड के रूप में पेयर करें**।

17. Gateway कहीं और चलता है, लेकिन वह Gateway WebSocket के माध्यम से आपकी लोकल मशीन पर `node.*` टूल्स (स्क्रीन, कैमरा, सिस्टम) कॉल कर सकता है। 18. सामान्य सेटअप:

19. Gateway को हमेशा-ऑन होस्ट (VPS/होम सर्वर) पर चलाएँ।

1. 20. Gateway होस्ट और अपने कंप्यूटर को एक ही tailnet पर रखें।
2. 21. सुनिश्चित करें कि Gateway WS पहुँचे योग्य है (tailnet bind या SSH टनल)।
3. 22. macOS ऐप को लोकली खोलें और **Remote over SSH** मोड (या डायरेक्ट tailnet) में कनेक्ट करें
       ताकि वह एक नोड के रूप में रजिस्टर हो सके।
4. 23. Gateway पर नोड को अप्रूव करें:
5. 24. अलग TCP ब्रिज की आवश्यकता नहीं है; नोड्स Gateway WebSocket के माध्यम से कनेक्ट होते हैं।

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

25) सुरक्षा रिमाइंडर: macOS नोड को पेयर करने से उस मशीन पर `system.run` की अनुमति मिलती है।

26. केवल
    उन डिवाइसों को पेयर करें जिन पर आप भरोसा करते हैं, और [Security](/gateway/security) की समीक्षा करें। 27. Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security)।

28. Tailscale कनेक्टेड है लेकिन मुझे कोई जवाब नहीं मिल रहा। अब क्या करूँ

### 29. बेसिक्स जाँचें:

30. Gateway चल रहा है: `openclaw gateway status`

- 31. Gateway हेल्थ: `openclaw status`
- 32. चैनल हेल्थ: `openclaw channels status`
- 33. फिर ऑथ और रूटिंग वेरिफ़ाई करें:

34. यदि आप Tailscale Serve का उपयोग करते हैं, तो सुनिश्चित करें कि `gateway.auth.allowTailscale` सही तरह से सेट है।

- 35. यदि आप SSH टनल के माध्यम से कनेक्ट करते हैं, तो पुष्टि करें कि लोकल टनल चालू है और सही पोर्ट की ओर इशारा कर रही है।
- 36. पुष्टि करें कि आपकी allowlists (DM या ग्रुप) में आपका अकाउंट शामिल है।
- 37. Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels)।

38. क्या दो OpenClaw इंस्टेंस एक-दूसरे से लोकल/VPS पर बात कर सकते हैं

### 39. हाँ।

40. कोई बिल्ट-इन "bot-to-bot" ब्रिज नहीं है, लेकिन आप इसे कुछ
    विश्वसनीय तरीकों से जोड़ सकते हैं: 41. **सबसे सरल:** एक सामान्य चैट चैनल का उपयोग करें जिसे दोनों बॉट एक्सेस कर सकें (Telegram/Slack/WhatsApp)।

42. Bot A, Bot B को एक संदेश भेजे, फिर Bot B सामान्य रूप से जवाब दे।
43. **CLI ब्रिज (जेनेरिक):** एक स्क्रिप्ट चलाएँ जो दूसरे Gateway को कॉल करे
    `openclaw agent --message ...` के साथ

44. `--deliver`, ऐसे चैट को टार्गेट करते हुए जहाँ दूसरा बॉट
    सुनता है। 45. यदि एक बॉट रिमोट VPS पर है, तो अपने CLI को उस रिमोट Gateway की ओर पॉइंट करें
    SSH/Tailscale के माध्यम से (देखें [Remote access](/gateway/remote)). 46. उदाहरण पैटर्न (ऐसी मशीन से चलाएँ जो टार्गेट Gateway तक पहुँच सके):

47. openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>

```bash
48. टिप: एक गार्डरेल जोड़ें ताकि दोनों बॉट अनंत लूप में न फँसें (केवल-मेंशन, चैनल
allowlists, या "बॉट संदेशों का जवाब न दें" नियम)।
```

49. Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send)।

50. क्या मुझे कई एजेंट्स के लिए अलग-अलग VPS की आवश्यकता है

### Do I need separate VPSes for multiple agents

1. नहीं। 2. एक Gateway कई agents को होस्ट कर सकता है, जिनमें से प्रत्येक का अपना workspace, model defaults,
   और routing होता है। 3. यही सामान्य सेटअप है और यह प्रति agent एक VPS चलाने की तुलना में कहीं सस्ता और सरल है।

4. अलग-अलग VPSes का उपयोग केवल तब करें जब आपको hard isolation (security boundaries) या बहुत अलग configs की आवश्यकता हो जिन्हें आप साझा नहीं करना चाहते। 5. अन्यथा, एक Gateway रखें और
   कई agents या sub-agents का उपयोग करें।

### 6. क्या VPS से SSH करने के बजाय अपने व्यक्तिगत लैपटॉप पर एक node इस्तेमाल करने का कोई लाभ है

7. हाँ – nodes आपके लैपटॉप तक रिमोट Gateway से पहुँचने का first-class तरीका हैं, और वे केवल shell access से कहीं अधिक सक्षम बनाते हैं। 8. Gateway macOS/Linux पर चलता है (Windows पर WSL2 के माध्यम से) और
   lightweight है (एक छोटा VPS या Raspberry Pi-क्लास बॉक्स पर्याप्त है; 4 GB RAM काफी है), इसलिए एक सामान्य सेटअप हमेशा-ऑन host के साथ आपका लैपटॉप एक node के रूप में होता है।

- 9. **कोई inbound SSH आवश्यक नहीं।** Nodes Gateway WebSocket से outbound कनेक्ट करते हैं और device pairing का उपयोग करते हैं।
- 10. **अधिक सुरक्षित execution controls।** `system.run` उस लैपटॉप पर node allowlists/approvals द्वारा नियंत्रित होता है।
- 11. **और अधिक device tools।** Nodes `system.run` के अलावा `canvas`, `camera`, और `screen` एक्सपोज़ करते हैं।
- 12. **Local browser automation।** Gateway को VPS पर रखें, लेकिन Chrome को स्थानीय रूप से चलाएँ और Chrome extension + लैपटॉप पर node host के साथ control relay करें।

13. SSH ad-hoc shell access के लिए ठीक है, लेकिन ongoing agent workflows और device automation के लिए nodes अधिक सरल हैं।

14. Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension)।

### 15. क्या मुझे दूसरे लैपटॉप पर install करना चाहिए या सिर्फ एक node जोड़ना चाहिए

16. यदि आपको दूसरे लैपटॉप पर केवल **local tools** (screen/camera/exec) की आवश्यकता है, तो उसे **node** के रूप में जोड़ें। 17. इससे एक ही Gateway बना रहता है और duplicated config से बचाव होता है। 18. Local node tools फिलहाल केवल macOS पर उपलब्ध हैं, लेकिन हम उन्हें अन्य OSes तक विस्तारित करने की योजना बना रहे हैं।

19. दूसरा Gateway केवल तब install करें जब आपको **hard isolation** या दो पूरी तरह अलग bots की आवश्यकता हो।

20. Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways)।

### 21. क्या nodes एक gateway service चलाते हैं

22. नहीं। 23. प्रति host केवल **एक gateway** चलना चाहिए, जब तक कि आप जानबूझकर isolated profiles न चला रहे हों (देखें [Multiple gateways](/gateway/multiple-gateways))। 24. Nodes peripherals होते हैं जो gateway से कनेक्ट होते हैं
    (iOS/Android nodes, या menubar ऐप में macOS "node mode")। 25. Headless node
    hosts और CLI control के लिए, देखें [Node host CLI](/cli/node)।

26. `gateway`, `discovery`, और `canvasHost` में बदलावों के लिए पूर्ण restart आवश्यक है।

### 27. क्या config लागू करने का कोई API RPC तरीका है

28. हाँ। 29. `config.apply` पूरे config को validate + write करता है और ऑपरेशन के हिस्से के रूप में Gateway को restart करता है।

### 30. configapply ने मेरा config मिटा दिया। मैं इसे कैसे recover करूँ और इससे कैसे बचूँ

31. `config.apply` **पूरे config** को replace करता है। 32. यदि आप एक partial object भेजते हैं, तो बाकी सब हटा दिया जाता है।

33. Recover:

- 34. Backup से restore करें (git या कॉपी किया हुआ `~/.openclaw/openclaw.json`)।
- 35. यदि आपके पास कोई backup नहीं है, तो `openclaw doctor` फिर से चलाएँ और channels/models को reconfigure करें।
- 36. यदि यह अप्रत्याशित था, तो bug file करें और अपना आख़िरी ज्ञात config या कोई भी backup शामिल करें।
- 37. एक local coding agent अक्सर logs या history से एक working config का पुनर्निर्माण कर सकता है।

38. इससे बचें:

- 39. छोटे बदलावों के लिए `openclaw config set` का उपयोग करें।
- 40. Interactive edits के लिए `openclaw configure` का उपयोग करें।

41. Docs: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor)।

### 42. पहली install के लिए एक minimal sane config क्या है

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

43. यह आपका workspace सेट करता है और यह सीमित करता है कि bot को कौन trigger कर सकता है।

### 44. मैं VPS पर Tailscale कैसे सेट करूँ और अपने Mac से कैसे connect करूँ

45. Minimal steps:

1. 46. **VPS पर install + login करें**

   ```bash
   47. curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. 48. **अपने Mac पर install + login करें**
   - 49. Tailscale ऐप का उपयोग करें और उसी tailnet में sign in करें।

3. 50. **MagicDNS सक्षम करें (recommended)**
   - In the Tailscale admin console, enable MagicDNS so the VPS has a stable name.

4. **Use the tailnet hostname**
   - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

If you want the Control UI without SSH, use Tailscale Serve on the VPS:

```bash
openclaw gateway --tailscale serve
```

This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).

### How do I connect a Mac node to a remote Gateway Tailscale Serve

Serve exposes the **Gateway Control UI + WS**. Nodes connect over the same Gateway WS endpoint.

Recommended setup:

1. **Make sure the VPS + Mac are on the same tailnet**.
2. **Use the macOS app in Remote mode** (SSH target can be the tailnet hostname).
   The app will tunnel the Gateway port and connect as a node.
3. **Approve the node** on the gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

## Env vars and .env loading

### OpenClaw environment variables कैसे लोड करता है

OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) और अतिरिक्त रूप से यह भी लोड करता है:

- `.env` from the current working directory
- `~/.openclaw/.env` से एक वैश्विक फ़ॉलबैक `.env` (उर्फ `$OPENCLAW_STATE_DIR/.env`)

इनमें से कोई भी `.env` फ़ाइल मौजूदा env vars को ओवरराइड नहीं करती।

You can also define inline env vars in config (applied only if missing from the process env):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
  },
}
```

पूर्ण प्राथमिकता और स्रोतों के लिए [/environment](/help/environment) देखें।

### I started the Gateway via the service and my env vars disappeared What now

दो सामान्य समाधान:

1. Put the missing keys in `~/.openclaw/.env` so they're picked up even when the service doesn't inherit your shell env.
2. Enable shell import (opt-in convenience):

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents:
`OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

### मैंने COPILOTGITHUBTOKEN सेट किया है लेकिन models status में Shell env off दिखता है, क्यों

`openclaw models status` reports whether **shell env import** is enabled. "Shell env: off"
does **not** mean your env vars are missing - it just means OpenClaw won't load
your login shell automatically.

If the Gateway runs as a service (launchd/systemd), it won't inherit your shell
environment. Fix by doing one of these:

1. Put the token in `~/.openclaw/.env`:

   ```
   COPILOT_GITHUB_TOKEN=...
   ```

2. Or enable shell import (`env.shellEnv.enabled: true`).

3. Or add it to your config `env` block (applies only if missing).

Then restart the gateway and recheck:

```bash
openclaw models status
```

Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).
See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

## Sessions and multiple chats

### How do I start a fresh conversation

Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).

### Do sessions reset automatically if I never send new

Yes. Sessions expire after `session.idleMinutes` (default **60**). The **next**
message starts a fresh session id for that chat key. This does not delete
transcripts - it just starts a new session.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### क्या OpenClaw instances की एक टीम बनाना संभव है — एक CEO और कई agents

हाँ, **multi-agent routing** और **sub-agents** के माध्यम से। आप एक coordinator एजेंट और कई worker एजेंट बना सकते हैं, जिनके अपने workspace और मॉडल हों।

यह सब कहा जाए तो, इसे सबसे बेहतर एक **मज़ेदार प्रयोग** के रूप में ही देखा जाना चाहिए। यह token के लिहाज़ से भारी होता है और अक्सर अलग-अलग sessions के साथ एक ही bot इस्तेमाल करने से कम कुशल होता है। हम जिस सामान्य मॉडल की कल्पना करते हैं, वह एक bot है जिससे आप बात करते हैं, और समानांतर काम के लिए अलग-अलग sessions होते हैं। वह bot ज़रूरत पड़ने पर sub-agents भी spawn कर सकता है।

Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### मिड-टास्क में context truncate क्यों हो गया और मैं इसे कैसे रोकूँ

Session context मॉडल की window द्वारा सीमित होता है। लंबी chats, बड़े tool outputs, या बहुत सारी फ़ाइलें
compaction या truncation को ट्रिगर कर सकती हैं।

क्या मदद करता है:

- Bot से वर्तमान स्थिति को summarize करने के लिए कहें और उसे एक file में लिखवाएँ।
- लंबे tasks से पहले `/compact` का उपयोग करें, और topics बदलते समय `/new` का उपयोग करें।
- महत्वपूर्ण context को workspace में रखें और bot से उसे दोबारा पढ़ने के लिए कहें।
- लंबे या parallel काम के लिए sub-agents का उपयोग करें ताकि main chat छोटा रहे।
- अगर ऐसा अक्सर होता है तो बड़े context window वाला मॉडल चुनें।

### मैं OpenClaw को पूरी तरह reset कैसे करूँ लेकिन उसे installed ही रखें

Reset command का उपयोग करें:

```bash
openclaw reset
```

Non-interactive full reset:

```bash
openclaw reset --scope full --yes --non-interactive
```

फिर onboarding दोबारा चलाएँ:

```bash
openclaw onboard --install-daemon
```

टिप्पणियाँ:

- Onboarding wizard मौजूदा config देखने पर **Reset** का विकल्प भी देता है। देखें [Wizard](/start/wizard).
- अगर आपने profiles (`--profile` / `OPENCLAW_PROFILE`) का उपयोग किया है, तो प्रत्येक state dir को reset करें (default `~/.openclaw-<profile>` हैं)।
- Dev reset: `openclaw gateway --dev --reset` (केवल dev के लिए; dev config + credentials + sessions + workspace को मिटा देता है)।

### मुझे context too large errors मिल रहे हैं, मैं reset या compact कैसे करूँ

इनमें से किसी एक का उपयोग करें:

- **Compact** (conversation को बनाए रखता है लेकिन पुराने turns को सारांशित करता है):

  ```
  /compact
  ```

  या summary को guide करने के लिए `/compact <instructions>`।

- **Reset** (उसी chat key के लिए नया session ID):

  ```
  /new
  /reset
  ```

अगर यह बार-बार होता रहे:

- पुराने tool output को trim करने के लिए **session pruning** (`agents.defaults.contextPruning`) को enable या tune करें।
- बड़े context window वाला मॉडल इस्तेमाल करें।

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### मुझे LLM request rejected messagesNcontentXtooluseinput Field required संदेश क्यों दिख रहे हैं

यह एक provider validation error है: मॉडल ने आवश्यक `input` के बिना एक `tool_use` block emit किया। आमतौर पर इसका मतलब होता है कि session history stale या corrupted है (अक्सर लंबी threads या tool/schema बदलाव के बाद)।

समाधान: `/new` के साथ एक fresh session शुरू करें (standalone message)।

### मुझे हर 30 मिनट में heartbeat messages क्यों मिल रहे हैं

Heartbeats डिफ़ॉल्ट रूप से हर **30m** में चलते हैं। इन्हें tune या disable करें:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "2h", // or "0m" to disable
      },
    },
  },
}
```

अगर `HEARTBEAT.md` मौजूद है लेकिन व्यावहारिक रूप से खाली है (सिर्फ blank lines और `# Heading` जैसे markdown headers), तो OpenClaw API calls बचाने के लिए heartbeat run को skip कर देता है।
यदि फ़ाइल गायब है, तो हार्टबीट फिर भी चलता है और मॉडल तय करता है कि क्या करना है।

Per-agent overrides के लिए `agents.list[].heartbeat` का उपयोग करें। Docs: [Heartbeat](/gateway/heartbeat).

### क्या मुझे WhatsApp group में एक bot account जोड़ने की ज़रूरत है

नहीं। 1. OpenClaw **आपके अपने खाते** पर चलता है, इसलिए अगर आप ग्रुप में हैं, तो OpenClaw उसे देख सकता है।
2. डिफ़ॉल्ट रूप से, ग्रुप रिप्लाई तब तक ब्लॉक रहते हैं जब तक आप सेंडर्स को अनुमति नहीं देते (`groupPolicy: "allowlist"`)।

3. अगर आप चाहते हैं कि केवल **आप** ही ग्रुप रिप्लाई ट्रिगर कर सकें:

```json5
4. {
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### 5. मैं WhatsApp ग्रुप का JID कैसे प्राप्त करूं

6. विकल्प 1 (सबसे तेज़): लॉग्स को टेल करें और ग्रुप में एक टेस्ट मैसेज भेजें:

```bash
7. openclaw logs --follow --json
```

8. `@g.us` पर खत्म होने वाला `chatId` (या `from`) देखें, जैसे:
   `1234567890-1234567890@g.us`।

9. विकल्प 2 (अगर पहले से कॉन्फ़िगर/अलाउलिस्ट किया हुआ है): कॉन्फ़िग से ग्रुप्स की सूची देखें:

```bash
10. openclaw directory groups list --channel whatsapp
```

11. डॉक्यूमेंट्स: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs)।

### 12. OpenClaw ग्रुप में जवाब क्यों नहीं देता

13. दो सामान्य कारण:

- 14. मेंशन गेटिंग चालू है (डिफ़ॉल्ट)। 15. आपको बॉट को @mention करना होगा (या `mentionPatterns` से मेल खाना होगा)।
- 16. आपने `channels.whatsapp.groups` को `"*"` के बिना कॉन्फ़िगर किया है और ग्रुप अलाउलिस्ट में नहीं है।

17. देखें [Groups](/channels/groups) और [Group messages](/channels/group-messages)।

### 18. क्या groups/threads DMs के साथ कॉन्टेक्स्ट साझा करते हैं

19. डायरेक्ट चैट्स डिफ़ॉल्ट रूप से मुख्य सेशन में मर्ज हो जाती हैं। 20. ग्रुप्स/चैनल्स की अपनी सेशन keys होती हैं, और Telegram topics / Discord threads अलग सेशन्स होते हैं। 21. देखें [Groups](/channels/groups) और [Group messages](/channels/group-messages)।

### 22. मैं कितने workspaces और agents बना सकता हूँ

23. कोई हार्ड लिमिट नहीं है। 24. दर्जनों (यहाँ तक कि सैकड़ों) भी ठीक हैं, लेकिन इन बातों पर नज़र रखें:

- 25. **डिस्क ग्रोथ:** सेशन्स + ट्रांसक्रिप्ट्स `~/.openclaw/agents/<agentId>/sessions/` के तहत रहते हैं।
- 26. **टोकन लागत:** अधिक एजेंट्स का मतलब है मॉडल का अधिक समवर्ती उपयोग।
- 27. **ऑप्स ओवरहेड:** प्रति-एजेंट ऑथ प्रोफाइल्स, वर्कस्पेसेज़, और चैनल रूटिंग।

सुझाव:

- 28. प्रति एजेंट एक **सक्रिय** वर्कस्पेस रखें (`agents.defaults.workspace`)।
- 29. अगर डिस्क बढ़ती है तो पुराने सेशन्स को प्रून करें (JSONL या स्टोर एंट्रीज़ डिलीट करें)।
- 30. स्ट्रे वर्कस्पेसेज़ और प्रोफाइल मिसमैच पहचानने के लिए `openclaw doctor` का उपयोग करें।

### 31. क्या मैं एक ही समय में Slack पर कई बॉट्स या चैट्स चला सकता हूँ और इसे कैसे सेटअप करूँ

32. हाँ। 33. कई आइसोलेटेड एजेंट्स चलाने और इनबाउंड मैसेजेज़ को चैनल/अकाउंट/पीयर के आधार पर रूट करने के लिए **Multi-Agent Routing** का उपयोग करें। 34. Slack एक सपोर्टेड चैनल है और इसे विशिष्ट एजेंट्स से बाइंड किया जा सकता है।

35. ब्राउज़र एक्सेस शक्तिशाली है, लेकिन "इंसान जो कर सकता है वह सब" नहीं — एंटी-बॉट, CAPTCHAs, और MFA अभी भी ऑटोमेशन को ब्लॉक कर सकते हैं। 36. सबसे विश्वसनीय ब्राउज़र कंट्रोल के लिए, ब्राउज़र चलाने वाली मशीन पर Chrome extension relay का उपयोग करें (और Gateway कहीं भी रखें)।

37. बेस्ट-प्रैक्टिस सेटअप:

- 38. हमेशा चालू Gateway होस्ट (VPS/Mac mini)।
- 39. प्रति भूमिका एक एजेंट (बाइंडिंग्स)।
- 40. उन एजेंट्स से बाइंड किए गए Slack चैनल(्स)।
- 41. ज़रूरत पड़ने पर एक्सटेंशन रिले (या एक नोड) के ज़रिए लोकल ब्राउज़र।

42. डॉक्यूमेंट्स: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
    [Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes)।

## 43. Models: डिफ़ॉल्ट्स, चयन, एलियासेज़, स्विचिंग

### 44. डिफ़ॉल्ट मॉडल क्या है

45. OpenClaw का डिफ़ॉल्ट मॉडल वही है जो आप इस तरह सेट करते हैं:

```
agents.defaults.model.primary
```

46. मॉडल्स को `provider/model` के रूप में रेफ़र किया जाता है (उदाहरण: `anthropic/claude-opus-4-6`)। 47. अगर आप provider छोड़ देते हैं, तो OpenClaw वर्तमान में अस्थायी डिप्रिकेशन फ़ॉलबैक के रूप में `anthropic` मान लेता है — लेकिन फिर भी आपको **स्पष्ट रूप से** `provider/model` सेट करना चाहिए।

### 48. आप कौन सा मॉडल सुझाते हैं

49. **अनुशंसित डिफ़ॉल्ट:** `anthropic/claude-opus-4-6`।
50. **अच्छा विकल्प:** `anthropic/claude-sonnet-4-5`।
51. **विश्वसनीय (कम व्यक्तित्व):** `openai/gpt-5.2` - लगभग Opus जितना अच्छा, बस व्यक्तित्व थोड़ा कम।
52. **बजट:** `zai/glm-4.7`.

3. MiniMax M2.1 के अपने दस्तावेज़ हैं: [MiniMax](/providers/minimax) और
   [Local models](/gateway/local-models).

4. सामान्य नियम: उच्च-जोखिम वाले काम के लिए **सबसे अच्छा मॉडल जो आप वहन कर सकते हैं** उपयोग करें, और नियमित चैट या सारांश के लिए सस्ता
   मॉडल। 5. आप प्रति एजेंट मॉडल रूट कर सकते हैं और लंबे कार्यों को
   समानांतर करने के लिए सब-एजेंट्स का उपयोग कर सकते हैं (हर सब-एजेंट टोकन खपत करता है)। 6. देखें [Models](/concepts/models) और
   [Sub-agents](/tools/subagents).

7. कड़ी चेतावनी: कमजोर/अत्यधिक क्वांटाइज़्ड मॉडल प्रॉम्प्ट
   इंजेक्शन और असुरक्षित व्यवहार के प्रति अधिक संवेदनशील होते हैं। 8. देखें [Security](/gateway/security).

9. अधिक संदर्भ: [Models](/concepts/models).

### 10. क्या मैं selfhosted मॉडल llamacpp vLLM Ollama उपयोग कर सकता हूँ

11. हाँ। 12. यदि आपका लोकल सर्वर OpenAI-संगत API प्रदान करता है, तो आप उसे
    कस्टम प्रोवाइडर के रूप में पॉइंट कर सकते हैं। 13. Ollama सीधे समर्थित है और सबसे आसान रास्ता है।

14. सुरक्षा नोट: छोटे या भारी रूप से क्वांटाइज़्ड मॉडल प्रॉम्प्ट
    इंजेक्शन के प्रति अधिक संवेदनशील होते हैं। 15. हम टूल्स का उपयोग करने वाले किसी भी बॉट के लिए **बड़े मॉडल** की जोरदार सिफारिश करते हैं।
15. यदि आप फिर भी छोटे मॉडल चाहते हैं, तो सैंडबॉक्सिंग और सख्त टूल allowlists सक्षम करें।

17. दस्तावेज़: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
    [Model providers](/concepts/model-providers), [Security](/gateway/security),
    [Sandboxing](/gateway/sandboxing).

### 18. मैं अपना कॉन्फ़िग मिटाए बिना मॉडल कैसे बदलूँ

19. **model commands** का उपयोग करें या केवल **model** फ़ील्ड्स संपादित करें। 20. पूरे कॉन्फ़िग को बदलने से बचें।

21. सुरक्षित विकल्प:

- 22. चैट में `/model` (तेज़, प्रति-सेशन)
- 23. `openclaw models set ...` (केवल मॉडल कॉन्फ़िग अपडेट करता है)
- 24. `openclaw configure --section model` (इंटरएक्टिव)
- 25. `~/.openclaw/openclaw.json` में `agents.defaults.model` संपादित करें

26. जब तक आप पूरे कॉन्फ़िग को बदलने का इरादा न रखें, आंशिक ऑब्जेक्ट के साथ `config.apply` से बचें।
27. यदि आपने कॉन्फ़िग ओवरराइट कर दिया है, तो बैकअप से पुनर्स्थापित करें या मरम्मत के लिए `openclaw doctor` दोबारा चलाएँ।

28. दस्तावेज़: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### 29. OpenClaw, Flawd और Krill मॉडल के लिए क्या उपयोग करते हैं

- 30. **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - देखें [Anthropic](/providers/anthropic).
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - देखें [MiniMax](/providers/minimax)।

### 32. बिना रीस्टार्ट किए चलते-चलते मॉडल कैसे बदलूँ

33. `/model` कमांड को एक स्टैंडअलोन संदेश के रूप में उपयोग करें:

```
34. /model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

35. आप उपलब्ध मॉडल `/model`, `/model list`, या `/model status` से सूचीबद्ध कर सकते हैं।

36. `/model` (और `/model list`) एक कॉम्पैक्ट, क्रमांकित पिकर दिखाता है। 37. नंबर से चयन करें:

```
38. /model 3
```

39. आप प्रोवाइडर के लिए एक विशिष्ट auth प्रोफ़ाइल भी मजबूर कर सकते हैं (प्रति-सेशन):

```
40. /model opus@anthropic:default
/model opus@anthropic:work
```

41. टिप: `/model status` दिखाता है कि कौन सा एजेंट सक्रिय है, कौन सी `auth-profiles.json` फ़ाइल उपयोग हो रही है, और अगला कौन सा auth प्रोफ़ाइल आज़माया जाएगा।
42. यह कॉन्फ़िगर किया गया प्रोवाइडर एंडपॉइंट (`baseUrl`) और API मोड (`api`) भी दिखाता है, जब उपलब्ध हो।

43. **मैं profile के साथ सेट किए गए प्रोफ़ाइल को कैसे अनपिन करूँ**

44. `@profile` suffix के **बिना** `/model` दोबारा चलाएँ:

```
45. /model anthropic/claude-opus-4-6
```

46. यदि आप डिफ़ॉल्ट पर लौटना चाहते हैं, तो उसे `/model` से चुनें (या `/model <default provider/model>` भेजें)।
47. कौन सा auth प्रोफ़ाइल सक्रिय है यह पुष्टि करने के लिए `/model status` उपयोग करें।

### 48. क्या मैं दैनिक कार्यों के लिए GPT 5.2 और कोडिंग के लिए Codex 5.3 उपयोग कर सकता हूँ

49. हाँ। 50. एक को डिफ़ॉल्ट के रूप में सेट करें और आवश्यकता अनुसार स्विच करें:

- 1. **त्वरित स्विच (प्रति सत्र):** दैनिक कार्यों के लिए `/model gpt-5.2`, कोडिंग के लिए `/model gpt-5.3-codex`।
- 2. **डिफ़ॉल्ट + स्विच:** `agents.defaults.model.primary` को `openai/gpt-5.2` पर सेट करें, फिर कोडिंग के समय `openai-codex/gpt-5.3-codex` पर स्विच करें (या इसके उलट)।
- 3. **सब-एजेंट्स:** कोडिंग कार्यों को अलग डिफ़ॉल्ट मॉडल वाले सब-एजेंट्स पर रूट करें।

4. देखें [Models](/concepts/models) और [Slash commands](/tools/slash-commands)।

### 5. मुझे “Model is not allowed” क्यों दिखाई देता है और फिर कोई जवाब नहीं आता?

6. यदि `agents.defaults.models` सेट है, तो यह `/model` और किसी भी सत्र ओवरराइड के लिए **allowlist** बन जाता है। 7. उस सूची में न होने वाला मॉडल चुनने पर यह मिलता है:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

8. यह त्रुटि सामान्य उत्तर के **बजाय** लौटाई जाती है। 9. समाधान: मॉडल को `agents.defaults.models` में जोड़ें, allowlist हटाएँ, या `/model list` से कोई मॉडल चुनें।

### 10. मुझे “Unknown model minimaxMiniMaxM21” क्यों दिखाई देता है?

11. इसका मतलब है कि **provider कॉन्फ़िगर नहीं है** (MiniMax provider कॉन्फ़िग या auth प्रोफ़ाइल नहीं मिली), इसलिए मॉडल resolve नहीं हो पा रहा। 12. इस डिटेक्शन के लिए एक फ़िक्स **2026.1.12** में है (लिखे जाने के समय unreleased)।

13. फ़िक्स चेकलिस्ट:

1. 14. **2026.1.12** में अपग्रेड करें (या सोर्स `main` से चलाएँ), फिर गेटवे रीस्टार्ट करें।
2. 15. सुनिश्चित करें कि MiniMax कॉन्फ़िगर है (wizard या JSON), या env/auth प्रोफ़ाइल में MiniMax API key मौजूद है ताकि provider inject हो सके।
3. 16. सटीक मॉडल id (case-sensitive) उपयोग करें: `minimax/MiniMax-M2.1` या `minimax/MiniMax-M2.1-lightning`।
4. Run:

   ```bash
   openclaw models list
   ```

   17. और सूची से चुनें (या चैट में `/model list`)।

18) देखें [MiniMax](/providers/minimax) और [Models](/concepts/models)।

### 19. क्या मैं MiniMax को डिफ़ॉल्ट और जटिल कार्यों के लिए OpenAI उपयोग कर सकता हूँ?

20. हाँ। 21. **MiniMax को डिफ़ॉल्ट** रखें और ज़रूरत पड़ने पर **प्रति सत्र** मॉडल स्विच करें।
21. Fallbacks **त्रुटियों** के लिए होते हैं, “कठिन कार्यों” के लिए नहीं, इसलिए `/model` या अलग एजेंट का उपयोग करें।

23. **विकल्प A: प्रति सत्र स्विच**

```json5
{
  env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.1" },
      models: {
        "minimax/MiniMax-M2.1": { alias: "minimax" },
        "openai/gpt-5.2": { alias: "gpt" },
      },
    },
  },
}
```

फिर:

```
25. /model gpt
```

26. **विकल्प B: अलग एजेंट्स**

- 27. एजेंट A डिफ़ॉल्ट: MiniMax
- 28. एजेंट B डिफ़ॉल्ट: OpenAI
- 29. एजेंट के अनुसार रूट करें या स्विच करने के लिए `/agent` का उपयोग करें

30. डॉक्युमेंट्स: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai)।

### 31. क्या opus sonnet gpt बिल्ट-इन शॉर्टकट हैं?

32. हाँ। 33. OpenClaw कुछ डिफ़ॉल्ट शॉर्टहैंड्स के साथ आता है (केवल तब लागू होते हैं जब मॉडल `agents.defaults.models` में मौजूद हो):

- 34. `opus` → `anthropic/claude-opus-4-6`
- 35. `sonnet` → `anthropic/claude-sonnet-4-5`
- 36. `gpt` → `openai/gpt-5.2`
- 37. `gpt-mini` → `openai/gpt-5-mini`
- 38. `gemini` → `google/gemini-3-pro-preview`
- 39. `gemini-flash` → `google/gemini-3-flash-preview`

40. यदि आप उसी नाम से अपना alias सेट करते हैं, तो आपका मान प्राथमिकता पाएगा।

### 41. मैं मॉडल शॉर्टकट aliases को कैसे परिभाषित/ओवरराइड करूँ?

42. Aliases `agents.defaults.models.<modelId>` से आते हैं43. `.alias`। उदाहरण:

```json5
44. {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-5": { alias: "sonnet" },
        "anthropic/claude-haiku-4-5": { alias: "haiku" },
      },
    },
  },
}
```

45. फिर `/model sonnet` (या जहाँ समर्थित हो वहाँ `/<alias>`) उस मॉडल ID में resolve होता है।

### 46. मैं OpenRouter या ZAI जैसे अन्य providers से मॉडल कैसे जोड़ूँ?

47. OpenRouter (pay-per-token; कई मॉडल):

```json5
48. {
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

49. Z.AI (GLM मॉडल्स):

```json5
50. {
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

यदि आप किसी provider/model का संदर्भ देते हैं लेकिन आवश्यक provider key मौजूद नहीं है, तो आपको runtime auth error मिलेगा (जैसे `No API key found for provider "zai"`).

**नया एजेंट जोड़ने के बाद provider के लिए कोई API key नहीं मिली**

आमतौर पर इसका मतलब है कि **नया एजेंट** का auth store खाली है। Auth प्रति-एजेंट होता है और
यहाँ संग्रहीत होता है:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

समाधान विकल्प:

- `openclaw agents add <id>` चलाएँ और विज़ार्ड के दौरान auth कॉन्फ़िगर करें।
- या मुख्य एजेंट के `agentDir` से `auth-profiles.json` को नए एजेंट के `agentDir` में कॉपी करें।

एजेंट्स के बीच `agentDir` को **दोबारा उपयोग न करें**; इससे auth/session टकराव होते हैं।

## Model failover और "All models failed"

### Failover कैसे काम करता है

Failover दो चरणों में होता है:

1. एक ही provider के भीतर **Auth profile rotation**।
2. `agents.defaults.model.fallbacks` में अगले मॉडल पर **मॉडल फॉलबैक**।

असफल हो रहे profiles पर cooldown लागू होते हैं (exponential backoff), ताकि OpenClaw provider के rate-limited या अस्थायी रूप से विफल होने पर भी जवाब देता रहे।

### यह त्रुटि क्या दर्शाती है

```
प्रोफ़ाइल "anthropic:default" के लिए कोई credentials नहीं मिले
```

इसका मतलब है कि सिस्टम ने auth profile ID `anthropic:default` का उपयोग करने की कोशिश की, लेकिन अपेक्षित auth store में उसके लिए credentials नहीं मिले।

### No credentials found for profile anthropicdefault के लिए Fix checklist

- **यह पुष्टि करें कि auth profiles कहाँ रहते हैं** (नए बनाम legacy paths)
  - Current: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - Legacy: `~/.openclaw/agent/*` (`openclaw doctor` द्वारा migrated)
- **यह सुनिश्चित करें कि आपका env var Gateway द्वारा लोड हो रहा है**
  - यदि आपने अपने shell में `ANTHROPIC_API_KEY` सेट किया है लेकिन Gateway को systemd/launchd के जरिए चला रहे हैं, तो संभव है कि वह इसे inherit न करे। इसे `~/.openclaw/.env` में रखें या `env.shellEnv` सक्षम करें।
- **सुनिश्चित करें कि आप सही एजेंट को संपादित कर रहे हैं**
  - Multi-agent सेटअप में कई `auth-profiles.json` फ़ाइलें हो सकती हैं।
- **Model/auth स्थिति की sanity-check करें**
  - कॉन्फ़िगर किए गए models और providers authenticated हैं या नहीं, यह देखने के लिए `openclaw models status` का उपयोग करें।

**No credentials found for profile anthropic के लिए Fix checklist**

इसका मतलब है कि रन एक Anthropic auth profile पर pinned है, लेकिन Gateway
अपने auth store में उसे नहीं ढूँढ पा रहा है।

- **setup-token का उपयोग करें**
  - `claude setup-token` चलाएँ, फिर इसे `openclaw models auth setup-token --provider anthropic` के साथ पेस्ट करें।
  - यदि token किसी अन्य मशीन पर बनाया गया था, तो `openclaw models auth paste-token --provider anthropic` का उपयोग करें।

- **यदि आप इसके बजाय API key का उपयोग करना चाहते हैं**
  - **gateway host** पर `~/.openclaw/.env` में `ANTHROPIC_API_KEY` रखें।
  - किसी भी pinned order को साफ़ करें जो किसी missing profile को मजबूर करता है:

    ```bash
    openclaw models auth order clear --provider anthropic
    ```

- **यह पुष्टि करें कि आप commands gateway host पर चला रहे हैं**
  - Remote mode में, auth profiles gateway मशीन पर रहते हैं, आपकी लैपटॉप पर नहीं।

### इसने Google Gemini को भी क्यों आज़माया और विफल हुआ

यदि आपके model config में Google Gemini fallback के रूप में शामिल है (या आपने Gemini shorthand पर स्विच किया), तो model fallback के दौरान OpenClaw इसे आज़माएगा। यदि आपने Google credentials कॉन्फ़िगर नहीं किए हैं, तो आपको `No API key found for provider "google"` दिखाई देगा।

Fix: या तो Google auth प्रदान करें, या `agents.defaults.model.fallbacks` / aliases में Google models को हटाएँ/टालें ताकि fallback वहाँ route न करे।

**LLM request rejected message thinking signature required google antigravity**

Cause: session history में **बिना signature वाले thinking blocks** मौजूद हैं (अक्सर किसी aborted/partial stream से)। Google Antigravity को thinking blocks के लिए signatures आवश्यक होते हैं।

Fix: OpenClaw अब Google Antigravity Claude के लिए unsigned thinking blocks को हटा देता है। यदि यह फिर भी दिखाई दे, तो **नई session** शुरू करें या उस एजेंट के लिए `/thinking off` सेट करें।

## Auth profiles: वे क्या हैं और उन्हें कैसे प्रबंधित करें

Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

### Auth profile क्या है

Auth profile एक provider से जुड़ा हुआ नामित credential रिकॉर्ड (OAuth या API key) होता है। Profiles live in:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### What are typical profile IDs

OpenClaw uses provider-prefixed IDs like:

- `anthropic:default` (common when no email identity exists)
- `anthropic:<email>` for OAuth identities
- custom IDs you choose (e.g. `anthropic:work`)

### Can I control which auth profile is tried first

Yes. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

OpenClaw may temporarily skip a profile if it's in a short **cooldown** (rate limits/timeouts/auth failures) or a longer **disabled** state (billing/insufficient credits). To inspect this, run `openclaw models status --json` and check `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

You can also set a **per-agent** order override (stored in that agent's `auth-profiles.json`) via the CLI:

```bash
# Defaults to the configured default agent (omit --agent)
openclaw models auth order get --provider anthropic

# Lock rotation to a single profile (only try this one)
openclaw models auth order set --provider anthropic anthropic:default

# Or set an explicit order (fallback within provider)
openclaw models auth order set --provider anthropic anthropic:work anthropic:default

# Clear override (fall back to config auth.order / round-robin)
openclaw models auth order clear --provider anthropic
```

To target a specific agent:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs API key whats the difference

OpenClaw supports both:

- **OAuth** often leverages subscription access (where applicable).
- **API keys** use pay-per-token billing.

The wizard explicitly supports Anthropic setup-token and OpenAI Codex OAuth and can store API keys for you.

## Gateway: ports, "already running", and remote mode

### What port does the Gateway use

`gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).

प्राथमिकता क्रम:

```
--port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
```

### Why does openclaw gateway status say Runtime running but RPC probe failed

Because "running" is the **supervisor's** view (launchd/systemd/schtasks). The RPC probe is the CLI actually connecting to the gateway WebSocket and calling `status`.

Use `openclaw gateway status` and trust these lines:

- `Probe target:` (the URL the probe actually used)
- `Listening:` (what's actually bound on the port)
- `Last gateway error:` (common root cause when the process is alive but the port isn't listening)

### Why does openclaw gateway status show Config cli and Config service different

You're editing one config file while the service is running another (often a `--profile` / `OPENCLAW_STATE_DIR` mismatch).

Fix:

```bash
openclaw gateway install --force
```

Run that from the same `--profile` / environment you want the service to use.

### What does another gateway instance is already listening mean

OpenClaw enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` indicating another instance is already listening.

Fix: stop the other instance, free the port, or run with `openclaw gateway --port <port>`.

### How do I run OpenClaw in remote mode client connects to a Gateway elsewhere

Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with a token/password:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

टिप्पणियाँ:

- `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).
- The macOS app watches the config file and switches modes live when these values change.

### The Control UI says unauthorized or keeps reconnecting What now

Your gateway is running with auth enabled (`gateway.auth.*`), but the UI is not sending the matching token/password.

Facts (from code):

- Control UI ब्राउज़र के localStorage कुंजी `openclaw.control.settings.v1` में टोकन को स्टोर करता है।

Fix:

- सबसे तेज़: `openclaw dashboard` (डैशबोर्ड URL प्रिंट + कॉपी करता है, खोलने की कोशिश करता है; headless होने पर SSH संकेत दिखाता है)।
- यदि आपके पास अभी टोकन नहीं है: `openclaw doctor --generate-gateway-token`।
- यदि रिमोट है, तो पहले टनल करें: `ssh -N -L 18789:127.0.0.1:18789 user@host` फिर `http://127.0.0.1:18789/` खोलें।
- गेटवे होस्ट पर `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`) सेट करें।
- Control UI सेटिंग्स में वही टोकन पेस्ट करें।
- अब भी अटके हुए हैं? `openclaw status --all` चलाएँ और [Troubleshooting](/gateway/troubleshooting) का पालन करें। ऑथ विवरण के लिए [Dashboard](/web/dashboard) देखें।

### मैंने gatewaybind tailnet सेट किया है लेकिन यह bind नहीं कर पा रहा, कुछ भी listen नहीं कर रहा।

`tailnet` bind आपकी नेटवर्क इंटरफेस से एक Tailscale IP चुनता है (100.64.0.0/10)। यदि मशीन Tailscale पर नहीं है (या इंटरफेस डाउन है), तो bind करने के लिए कुछ भी नहीं है।

Fix:

- उस होस्ट पर Tailscale शुरू करें (ताकि उसके पास 100.x पता हो), या
- `gateway.bind: "loopback"` / `"lan"` पर स्विच करें।

नोट: `tailnet` स्पष्ट (explicit) है। `auto` loopback को प्राथमिकता देता है; जब आप केवल tailnet bind चाहते हों तो `gateway.bind: "tailnet"` उपयोग करें।

### क्या मैं एक ही होस्ट पर कई Gateways चला सकता हूँ

आमतौर पर नहीं — एक Gateway कई messaging channels और agents चला सकता है। कई Gateways का उपयोग केवल तब करें जब आपको redundancy (उदा: rescue bot) या कड़ा isolation चाहिए।

हाँ, लेकिन आपको isolation करना होगा:

- `OPENCLAW_CONFIG_PATH` (प्रति-इंस्टेंस config)
- `OPENCLAW_STATE_DIR` (प्रति-इंस्टेंस state)
- `agents.defaults.workspace` (workspace isolation)
- `gateway.port` (अद्वितीय ports)

त्वरित सेटअप (अनुशंसित):

- प्रति-इंस्टेंस `openclaw --profile <name> …` का उपयोग करें (स्वतः `~/.openclaw-<name>` बनाता है)।
- प्रत्येक प्रोफ़ाइल config में एक अद्वितीय `gateway.port` सेट करें (या मैनुअल रन के लिए `--port` पास करें)।
- प्रति-प्रोफ़ाइल सेवा इंस्टॉल करें: `openclaw --profile <name> gateway install`।

प्रोफ़ाइल्स सेवा नामों में suffix भी जोड़ते हैं (`bot.molt.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`)।
पूर्ण गाइड: [Multiple gateways](/gateway/multiple-gateways)।

### invalid handshake code 1008 का क्या मतलब है

Gateway एक **WebSocket server** है, और यह बहुत पहला संदेश `connect` फ्रेम होने की अपेक्षा करता है। यदि इसे कुछ और मिलता है, तो यह कनेक्शन को **code 1008** (policy violation) के साथ बंद कर देता है।

सामान्य कारण:

- आपने WS क्लाइंट की बजाय ब्राउज़र में **HTTP** URL (`http://...`) खोला।
- आपने गलत पोर्ट या पाथ का उपयोग किया।
- किसी proxy या tunnel ने auth headers हटा दिए या non-Gateway अनुरोध भेजा।

त्वरित समाधान:

1. WS URL का उपयोग करें: `ws://<host>:18789` (या HTTPS होने पर `wss://...`)।
2. WS पोर्ट को सामान्य ब्राउज़र टैब में न खोलें।
3. यदि auth चालू है, तो `connect` फ्रेम में टोकन/पासवर्ड शामिल करें।

यदि आप CLI या TUI का उपयोग कर रहे हैं, तो URL ऐसा दिखना चाहिए:

```
openclaw tui --url ws://<host>:18789 --token <token>
```

प्रोटोकॉल विवरण: [Gateway protocol](/gateway/protocol)।

## लॉगिंग और डिबगिंग

### लॉग कहाँ हैं

फ़ाइल लॉग्स (structured):

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

आप `logging.file` के माध्यम से एक स्थिर पाथ सेट कर सकते हैं। फ़ाइल लॉग स्तर `logging.level` द्वारा नियंत्रित होता है। 1. कंसोल वर्बोसिटी `--verbose` और `logging.consoleLevel` द्वारा नियंत्रित होती है।

2. सबसे तेज़ लॉग टेल:

```bash
openclaw logs --follow
```

3. सेवा/सुपरवाइज़र लॉग (जब गेटवे launchd/systemd के माध्यम से चलता है):

- 4. macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` और `gateway.err.log` (डिफ़ॉल्ट: `~/.openclaw/logs/...`; प्रोफ़ाइल `~/.openclaw-<profile>/logs/...` का उपयोग करती हैं)
- 5. Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- 6. Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

7. अधिक जानकारी के लिए [Troubleshooting](/gateway/troubleshooting#log-locations) देखें।

### 8. मैं Gateway सेवा को startstoprestart कैसे करूँ

9. गेटवे हेल्पर्स का उपयोग करें:

```bash
10. openclaw gateway status
openclaw gateway restart
```

11. यदि आप गेटवे को मैन्युअली चला रहे हैं, तो `openclaw gateway --force` पोर्ट को दोबारा हासिल कर सकता है। 12. [Gateway](/gateway) देखें।

### 13. मैंने Windows पर अपना टर्मिनल बंद कर दिया है, मैं OpenClaw को कैसे रीस्टार्ट करूँ

14. **Windows में इंस्टॉल के दो मोड** हैं:

15. **1) WSL2 (अनुशंसित):** Gateway Linux के अंदर चलता है।

16. PowerShell खोलें, WSL में जाएँ, फिर रीस्टार्ट करें:

```powershell
17. wsl
openclaw gateway status
openclaw gateway restart
```

18. यदि आपने कभी सेवा इंस्टॉल नहीं की, तो इसे फ़ोरग्राउंड में शुरू करें:

```bash
openclaw gateway run
```

19. **2) नेटिव Windows (अनुशंसित नहीं):** Gateway सीधे Windows में चलता है।

20. PowerShell खोलें और चलाएँ:

```powershell
21. openclaw gateway status
openclaw gateway restart
```

22. यदि आप इसे मैन्युअली (बिना सेवा) चला रहे हैं, तो उपयोग करें:

```powershell
openclaw gateway run
```

23. दस्तावेज़: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway)।

### 24. Gateway चालू है लेकिन जवाब कभी नहीं आते — मुझे क्या जाँच करना चाहिए

25. एक त्वरित हेल्थ स्विप से शुरू करें:

```bash
26. openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

27. सामान्य कारण:

- 28. **gateway host** पर मॉडल ऑथ लोड नहीं है (`models status` जाँचें)।
- 29. चैनल पेयरिंग/एलाउलिस्ट जवाबों को ब्लॉक कर रही है (चैनल कॉन्फ़िग + लॉग जाँचें)।
- 30. WebChat/Dashboard सही टोकन के बिना खुला है।

31. यदि आप रिमोट हैं, तो पुष्टि करें कि टनल/Tailscale कनेक्शन चालू है और Gateway WebSocket पहुँच योग्य है।

32. दस्तावेज़: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote)।

### 33. गेटवे से बिना वजह डिस्कनेक्ट हो गया — अब क्या

34. आमतौर पर इसका मतलब है कि UI ने WebSocket कनेक्शन खो दिया है। 35. जाँचें:

1. 36. क्या Gateway चल रहा है? `openclaw gateway status`
2. 37. क्या Gateway स्वस्थ है? `openclaw status`
3. 38. क्या UI के पास सही टोकन है? `openclaw dashboard`
4. 39. यदि रिमोट हैं, तो क्या टनल/Tailscale लिंक चालू है?

40) फिर लॉग टेल करें:

```bash
openclaw logs --follow
```

41. दस्तावेज़: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting)।

### 42. Telegram setMyCommands नेटवर्क त्रुटियों के साथ फेल हो रहा है — मुझे क्या जाँच करना चाहिए

43. लॉग और चैनल स्टेटस से शुरू करें:

```bash
44. openclaw channels status
openclaw channels logs --channel telegram
```

45. यदि आप VPS पर हैं या किसी प्रॉक्सी के पीछे हैं, तो सुनिश्चित करें कि आउटबाउंड HTTPS की अनुमति है और DNS काम कर रहा है।
46. यदि Gateway रिमोट है, तो सुनिश्चित करें कि आप Gateway होस्ट पर मौजूद लॉग देख रहे हैं।

47. दस्तावेज़: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting)।

### 48. TUI में कोई आउटपुट नहीं दिख रहा — मुझे क्या जाँच करना चाहिए

49. पहले पुष्टि करें कि Gateway पहुँच योग्य है और एजेंट चल सकता है:

```bash
50. openclaw status
openclaw models status
openclaw logs --follow
```

In the TUI, use `/status` to see the current state. If you expect replies in a chat
channel, make sure delivery is enabled (`/deliver on`).

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### How do I completely stop then start the Gateway

If you installed the service:

```bash
openclaw gateway stop
openclaw gateway start
```

This stops/starts the **supervised service** (launchd on macOS, systemd on Linux).
Use this when the Gateway runs in the background as a daemon.

If you're running in the foreground, stop with Ctrl-C, then:

```bash
openclaw gateway run
```

Docs: [Gateway service runbook](/gateway).

### ELI5 openclaw gateway restart vs openclaw gateway

- `openclaw gateway restart`: restarts the **background service** (launchd/systemd).
- `openclaw gateway`: runs the gateway **in the foreground** for this terminal session.

If you installed the service, use the gateway commands. Use `openclaw gateway` when
you want a one-off, foreground run.

### What's the fastest way to get more details when something fails

Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for channel auth, model routing, and RPC errors.

## Media and attachments

### My skill generated an imagePDF but nothing was sent

Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [OpenClaw assistant setup](/start/openclaw) and [Agent send](/tools/agent-send).

CLI sending:

```bash
openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

Also check:

- The target channel supports outbound media and isn't blocked by allowlists.
- The file is within the provider's size limits (images are resized to max 2048px).

See [Images](/nodes/images).

## Security and access control

### Is it safe to expose OpenClaw to inbound DMs

Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

- Default behavior on DM-capable channels is **pairing**:
  - Unknown senders receive a pairing code; the bot does not process their message.
  - Approve with: `openclaw pairing approve <channel> <code>`
  - Pending requests are capped at **3 per channel**; check `openclaw pairing list <channel>` if a code didn't arrive.
- Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).

Run `openclaw doctor` to surface risky DM policies.

### Is prompt injection only a concern for public bots

No. Prompt injection is about **untrusted content**, not just who can DM the bot.
If your assistant reads external content (web search/fetch, browser pages, emails,
docs, attachments, pasted logs), that content can include instructions that try
to hijack the model. This can happen even if **you are the only sender**.

The biggest risk is when tools are enabled: the model can be tricked into
exfiltrating context or calling tools on your behalf. Reduce the blast radius by:

- using a read-only or tool-disabled "reader" agent to summarize untrusted content
- keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents
- sandboxing and strict tool allowlists

Details: [Security](/gateway/security).

### Should my bot have its own email GitHub account or phone number

1. हाँ, अधिकांश सेटअप्स के लिए। 2. अलग-अलग अकाउंट्स और फ़ोन नंबरों के साथ बॉट को अलग रखना
   अगर कुछ गलत हो जाए तो प्रभाव के दायरे को कम करता है। 3. इससे क्रेडेंशियल्स को घुमाना या एक्सेस रद्द करना भी आसान हो जाता है,
   बिना आपके व्यक्तिगत अकाउंट्स को प्रभावित किए।

4. छोटे स्तर से शुरू करें। 5. केवल उन्हीं टूल्स और अकाउंट्स को एक्सेस दें जिनकी आपको वास्तव में ज़रूरत है, और ज़रूरत पड़ने पर
   बाद में विस्तार करें।

6. Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

### 7. क्या मैं इसे अपने टेक्स्ट मैसेजेज़ पर पूरी स्वायत्तता दे सकता हूँ और क्या यह सुरक्षित है

8. हम आपके व्यक्तिगत संदेशों पर पूरी स्वायत्तता की **सिफ़ारिश नहीं** करते। 9. सबसे सुरक्षित पैटर्न यह है:

- 10. DMs को **pairing mode** या एक सख़्त allowlist में रखें।
- 11. अगर आप चाहते हैं कि यह आपकी ओर से मैसेज भेजे, तो **एक अलग नंबर या अकाउंट** इस्तेमाल करें।
- 12. इसे ड्राफ्ट करने दें, फिर **भेजने से पहले अनुमोदन करें**।

अगर आप प्रयोग करना चाहते हैं, तो इसे किसी समर्पित account पर करें और उसे अलग-थलग रखें। 14. देखें
[Security](/gateway/security).

### 15. क्या मैं व्यक्तिगत सहायक कार्यों के लिए सस्ते मॉडल इस्तेमाल कर सकता हूँ

16. हाँ, **यदि** एजेंट केवल चैट-आधारित है और इनपुट विश्वसनीय है। 17. छोटे टियर निर्देश हाइजैकिंग के प्रति अधिक संवेदनशील होते हैं, इसलिए टूल-सक्षम एजेंट्स के लिए
    या अविश्वसनीय कंटेंट पढ़ते समय उनसे बचें। 18. अगर आपको छोटा मॉडल इस्तेमाल करना ही पड़े, तो टूल्स को लॉक डाउन करें
    और सैंडबॉक्स के अंदर चलाएँ। 19. देखें [Security](/gateway/security).

### 20. मैंने Telegram में start चलाया लेकिन मुझे pairing code नहीं मिला

21. Pairing codes **केवल** तब भेजे जाते हैं जब कोई अज्ञात प्रेषक बॉट को मैसेज करता है और
    `dmPolicy: "pairing"` सक्षम होता है। 22. केवल `/start` अपने आप में कोई कोड उत्पन्न नहीं करता।

23. लंबित अनुरोध जाँचें:

```bash
openclaw pairing list telegram
```

24. अगर आप तुरंत एक्सेस चाहते हैं, तो अपने sender id को allowlist करें या उस अकाउंट के लिए `dmPolicy: "open"`
    सेट करें।

### 25. WhatsApp पर क्या यह मेरे कॉन्टैक्ट्स को मैसेज करेगा? Pairing कैसे काम करता है

26. नहीं। 27. डिफ़ॉल्ट WhatsApp DM नीति **pairing** है। 28. अज्ञात प्रेषकों को केवल एक pairing code मिलता है और उनका संदेश **प्रोसेस नहीं किया जाता**। 29. OpenClaw केवल उन्हीं चैट्स को जवाब देता है जिन्हें वह प्राप्त करता है या उन स्पष्ट sends पर जिन्हें आप ट्रिगर करते हैं।

30. Pairing को इस प्रकार अनुमोदित करें:

```bash
31. openclaw pairing approve whatsapp <code>
```

32. लंबित अनुरोधों की सूची:

```bash
openclaw pairing list whatsapp
```

33. Wizard फ़ोन नंबर प्रॉम्प्ट: इसका उपयोग आपकी **allowlist/owner** सेट करने के लिए किया जाता है ताकि आपके अपने DMs की अनुमति हो। 34. इसका उपयोग ऑटो-सेंडिंग के लिए नहीं किया जाता। 35. अगर आप अपने व्यक्तिगत WhatsApp नंबर पर चला रहे हैं, तो उसी नंबर का उपयोग करें और `channels.whatsapp.selfChatMode` सक्षम करें।

## 36. चैट कमांड्स, टास्क्स को रोकना, और "it won't stop"

### 37. मैं आंतरिक सिस्टम संदेशों को चैट में दिखने से कैसे रोकूँ

38. अधिकांश आंतरिक या टूल संदेश केवल तब दिखाई देते हैं जब उस सत्र के लिए **verbose** या **reasoning** सक्षम हो।

39. जिस चैट में आप इसे देख रहे हैं वहीं ठीक करें:

```
40. /verbose off
/reasoning off
```

41. अगर फिर भी ज़्यादा शोर है, तो Control UI में सत्र सेटिंग्स जाँचें और verbose को **inherit** पर सेट करें। 42. यह भी पुष्टि करें कि आप ऐसा बॉट प्रोफ़ाइल इस्तेमाल नहीं कर रहे हैं जिसमें config में `verboseDefault`
    `on` पर सेट हो।

43. Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### 44. मैं चल रहे टास्क को कैसे रोकूँ/रद्द करूँ

45. इनमें से किसी को भी **एक स्वतंत्र संदेश के रूप में** भेजें (कोई स्लैश नहीं):

```
46. stop
abort
esc
wait
exit
interrupt
```

47. ये abort triggers हैं (slash commands नहीं)।

48. बैकग्राउंड प्रोसेस (exec टूल से) के लिए, आप एजेंट से यह चलाने को कह सकते हैं:

```
49. process action:kill sessionId:XXX
```

50. Slash commands का अवलोकन: देखें [Slash commands](/tools/slash-commands).

Most commands must be sent as a **standalone** message that starts with `/`, but a few shortcuts (like `/status`) also work inline for allowlisted senders.

### How do I send a Discord message from Telegram Crosscontext messaging denied

OpenClaw blocks **cross-provider** messaging by default. If a tool call is bound
to Telegram, it won't send to Discord unless you explicitly allow it.

Enable cross-provider messaging for the agent:

```json5
{
  agents: {
    defaults: {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marker: { enabled: true, prefix: "[from {channel}] " },
          },
        },
      },
    },
  },
}
```

Restart the gateway after editing config. If you only want this for a single
agent, set it under `agents.list[].tools.message` instead.

### Why does it feel like the bot ignores rapidfire messages

Queue mode controls how new messages interact with an in-flight run. Use `/queue` to change modes:

- `steer` - new messages redirect the current task
- `followup` - messages को एक-एक करके चलाएँ
- `collect` - batch messages and reply once (default)
- `steer-backlog` - steer now, then process backlog
- `interrupt` - abort current run and start fresh

You can add options like `debounce:2s cap:25 drop:summarize` for followup modes.

## Answer the exact question from the screenshot/chat log

**Q: "What's the default model for Anthropic with an API key?"**

**A:** In OpenClaw, credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agents.defaults.model.primary` (for example, `anthropic/claude-sonnet-4-5` or `anthropic/claude-opus-4-6`). If you see `No credentials found for profile "anthropic:default"`, it means the Gateway couldn't find Anthropic credentials in the expected `auth-profiles.json` for the agent that's running.

---

Still stuck? Ask in [Discord](https://discord.com/invite/clawd) or open a [GitHub discussion](https://github.com/openclaw/openclaw/discussions).
