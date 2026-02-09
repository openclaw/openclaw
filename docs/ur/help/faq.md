---
summary: "OpenClaw کے سیٹ اپ، کنفیگریشن، اور استعمال سے متعلق عمومی سوالات"
title: "عمومی سوالات"
---

# عمومی سوالات

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## فہرستِ مضامین

- [فوری آغاز اور پہلی بار سیٹ اپ]
  - [میں پھنس گیا ہوں—سب سے تیز طریقہ کیا ہے؟](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw کو انسٹال اور سیٹ اپ کرنے کا تجویز کردہ طریقہ کیا ہے؟](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [آن بورڈنگ کے بعد ڈیش بورڈ کیسے کھولوں؟](#how-do-i-open-the-dashboard-after-onboarding)
  - [لوکل ہوسٹ بمقابلہ ریموٹ پر ڈیش بورڈ کی تصدیق (ٹوکن) کیسے کروں؟](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [مجھے کون سا رن ٹائم درکار ہے؟](#what-runtime-do-i-need)
  - [کیا یہ Raspberry Pi پر چلتا ہے؟](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi انسٹال کے لیے کوئی مشورے؟](#any-tips-for-raspberry-pi-installs)
  - [It is stuck on "wake up my friend" / onboarding will not hatch. What now?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [کیا میں آن بورڈنگ دوبارہ کیے بغیر اپنا سیٹ اپ نئی مشین (Mac mini) پر منتقل کر سکتا ہوں؟](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [تازہ ترین ورژن میں نیا کیا ہے، کہاں دیکھوں؟](#where-do-i-see-what-is-new-in-the-latest-version)
  - [I can't access docs.openclaw.ai (SSL error). What now?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable اور beta میں کیا فرق ہے؟](#whats-the-difference-between-stable-and-beta)
  - [beta ورژن کیسے انسٹال کروں، اور beta اور dev میں کیا فرق ہے؟](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [میں تازہ ترین بِٹس کیسے آزماؤں؟](#how-do-i-try-the-latest-bits)
  - [انسٹال اور آن بورڈنگ میں عموماً کتنا وقت لگتا ہے؟](#how-long-does-install-and-onboarding-usually-take)
  - [Installer stuck? How do I get more feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows انسٹال میں git نہیں ملا یا openclaw پہچانا نہیں گیا](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [دستاویزات نے میرا سوال حل نہیں کیا—بہتر جواب کیسے حاصل کروں؟](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Linux پر OpenClaw کیسے انسٹال کروں؟](#how-do-i-install-openclaw-on-linux)
  - [VPS پر OpenClaw کیسے انسٹال کروں؟](#how-do-i-install-openclaw-on-a-vps)
  - [کلاؤڈ/VPS انسٹال گائیڈز کہاں ہیں؟](#where-are-the-cloudvps-install-guides)
  - [کیا میں OpenClaw سے خود کو اپ ڈیٹ کروانے کو کہہ سکتا ہوں؟](#can-i-ask-openclaw-to-update-itself)
  - [آن بورڈنگ وزارڈ اصل میں کیا کرتا ہے؟](#what-does-the-onboarding-wizard-actually-do)
  - [کیا اسے چلانے کے لیے Claude یا OpenAI سبسکرپشن درکار ہے؟](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [کیا میں API کلید کے بغیر Claude Max سبسکرپشن استعمال کر سکتا ہوں؟](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic "setup-token" تصدیق کیسے کام کرتی ہے؟](#how-does-anthropic-setuptoken-auth-work)
  - [Anthropic setup-token کہاں ملتا ہے؟](#where-do-i-find-an-anthropic-setuptoken)
  - [کیا آپ Claude سبسکرپشن تصدیق (Claude Pro یا Max) کو سپورٹ کرتے ہیں؟](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Anthropic سے `HTTP 429: rate_limit_error` کیوں دکھ رہا ہے؟](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [کیا AWS Bedrock سپورٹڈ ہے؟](#is-aws-bedrock-supported)
  - [Codex تصدیق کیسے کام کرتی ہے؟](#how-does-codex-auth-work)
  - [کیا آپ OpenAI سبسکرپشن تصدیق (Codex OAuth) سپورٹ کرتے ہیں؟](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Gemini CLI OAuth کیسے سیٹ اپ کروں؟](#how-do-i-set-up-gemini-cli-oauth)
  - [کیا عام چیٹس کے لیے لوکل ماڈل ٹھیک ہے؟](#is-a-local-model-ok-for-casual-chats)
  - [میں ہوسٹڈ ماڈل ٹریفک کو کسی مخصوص ریجن میں کیسے رکھوں؟](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [کیا مجھے اسے انسٹال کرنے کے لیے Mac Mini خریدنا ہوگا؟](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage سپورٹ کے لیے Mac mini درکار ہے؟](#do-i-need-a-mac-mini-for-imessage-support)
  - [اگر میں OpenClaw چلانے کے لیے Mac mini خریدوں، تو کیا میں اسے اپنے MacBook Pro سے جوڑ سکتا ہوں؟](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [کیا میں Bun استعمال کر سکتا ہوں؟](#can-i-use-bun)
  - [Telegram: `allowFrom` میں کیا ڈالنا ہے؟](#telegram-what-goes-in-allowfrom)
  - [کیا ایک WhatsApp نمبر کو مختلف OpenClaw انسٹینسز کے ساتھ کئی لوگ استعمال کر سکتے ہیں؟](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [کیا میں "فاسٹ چیٹ" ایجنٹ اور "Opus برائے کوڈنگ" ایجنٹ چلا سکتا ہوں؟](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [کیا Homebrew Linux پر کام کرتا ہے؟](#does-homebrew-work-on-linux)
  - [hackable (git) انسٹال اور npm انسٹال میں کیا فرق ہے؟](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [کیا میں بعد میں npm اور git انسٹال کے درمیان سوئچ کر سکتا ہوں؟](#can-i-switch-between-npm-and-git-installs-later)
  - [کیا مجھے Gateway لیپ ٹاپ پر چلانا چاہیے یا VPS پر؟](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [OpenClaw کو ڈیڈیکیٹڈ مشین پر چلانا کتنا اہم ہے؟](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [کم از کم VPS ضروریات اور تجویز کردہ OS کیا ہے؟](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [کیا میں OpenClaw کو VM میں چلا سکتا ہوں اور کیا ضروریات ہیں؟](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)
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
  - [OpenClaw اپنا ڈیٹا کہاں محفوظ کرتا ہے؟](#where-does-openclaw-store-its-data)
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
  - [What's a minimal "sane" config for a first install?](#whats-a-minimal-sane-config-for-a-first-install)
  - [How do I set up Tailscale on a VPS and connect from my Mac?](#how-do-i-set-up-tailscale-on-a-vps-and-connect-from-my-mac)
  - [How do I connect a Mac node to a remote Gateway (Tailscale Serve)?](#how-do-i-connect-a-mac-node-to-a-remote-gateway-tailscale-serve)
  - [Should I install on a second laptop or just add a node?](#should-i-install-on-a-second-laptop-or-just-add-a-node)
- [Env vars اور .env لوڈنگ](#env-vars-and-env-loading)
  - [OpenClaw ماحولیاتی ویری ایبلز کیسے لوڈ کرتا ہے؟](#how-does-openclaw-load-environment-variables)
  - ["I started the Gateway via the service and my env vars disappeared." اب کیا کروں؟](#i-started-the-gateway-via-the-service-and-my-env-vars-disappeared-what-now)
  - [میں نے `COPILOT_GITHUB_TOKEN` سیٹ کیا ہے، لیکن ماڈلز اسٹیٹس میں "Shell env: off" دکھ رہا ہے۔ کیوں؟](#i-set-copilotgithubtoken-but-models-status-shows-shell-env-off-why)
- [سیشنز اور متعدد چیٹس](#sessions-and-multiple-chats)
  - [میں ایک نئی گفتگو کیسے شروع کروں؟](#how-do-i-start-a-fresh-conversation)
  - [اگر میں کبھی `/new` نہ بھیجوں تو کیا سیشن خود بخود ری سیٹ ہو جاتے ہیں؟](#do-sessions-reset-automatically-if-i-never-send-new)
  - [Is there a way to make a team of OpenClaw instances one CEO and many agents](#is-there-a-way-to-make-a-team-of-openclaw-instances-one-ceo-and-many-agents)
  - [کانٹیکسٹ ٹاسک کے درمیان کیوں کٹ گیا؟ میں اسے کیسے روکوں؟](#why-did-context-get-truncated-midtask-how-do-i-prevent-it)
  - [میں OpenClaw کو مکمل طور پر کیسے ری سیٹ کروں لیکن انسٹال رکھا جائے؟](#how-do-i-completely-reset-openclaw-but-keep-it-installed)
  - [I'm getting "context too large" errors - how do I reset or compact?](#im-getting-context-too-large-errors-how-do-i-reset-or-compact)
  - [مجھے یہ کیوں نظر آ رہا ہے "LLM request rejected: messages.N.content.X.tool_use.input: Field required"؟](#why-am-i-seeing-llm-request-rejected-messagesncontentxtooluseinput-field-required)
  - [مجھے ہر 30 منٹ بعد heartbeat پیغامات کیوں مل رہے ہیں؟](#why-am-i-getting-heartbeat-messages-every-30-minutes)
  - [کیا مجھے WhatsApp گروپ میں "bot account" شامل کرنے کی ضرورت ہے؟](#do-i-need-to-add-a-bot-account-to-a-whatsapp-group)
  - [میں WhatsApp گروپ کا JID کیسے حاصل کروں؟](#how-do-i-get-the-jid-of-a-whatsapp-group)
  - [OpenClaw گروپ میں جواب کیوں نہیں دیتا؟](#why-doesnt-openclaw-reply-in-a-group)
  - [کیا گروپس/تھریڈز DMs کے ساتھ کانٹیکسٹ شیئر کرتے ہیں؟](#do-groupsthreads-share-context-with-dms)
  - [میں کتنے ورک اسپیسز اور ایجنٹس بنا سکتا ہوں؟](#how-many-workspaces-and-agents-can-i-create)
  - [Can I run multiple bots or chats at the same time (Slack), and how should I set that up?](#can-i-run-multiple-bots-or-chats-at-the-same-time-slack-and-how-should-i-set-that-up)
- [ماڈلز: ڈیفالٹس، انتخاب، عرفیات، سوئچنگ](#models-defaults-selection-aliases-switching)
  - ["ڈیفالٹ ماڈل" کیا ہوتا ہے؟](#what-is-the-default-model)
  - [آپ کون سا ماڈل تجویز کرتے ہیں؟](#what-model-do-you-recommend)
  - [میں کنفیگ مٹائے بغیر ماڈلز کیسے تبدیل کروں؟](#how-do-i-switch-models-without-wiping-my-config)
  - [کیا میں self-hosted ماڈلز (llama.cpp, vLLM, Ollama) استعمال کر سکتا ہوں؟](#can-i-use-selfhosted-models-llamacpp-vllm-ollama)
  - [OpenClaw، Flawd، اور Krill ماڈلز کے لیے کیا استعمال کرتے ہیں؟](#what-do-openclaw-flawd-and-krill-use-for-models)
  - [میں بغیر ری اسٹارٹ کیے فوری طور پر ماڈلز کیسے تبدیل کروں؟](#how-do-i-switch-models-on-the-fly-without-restarting)
  - [کیا میں روزمرہ کے کاموں کے لیے GPT 5.2 اور کوڈنگ کے لیے Codex 5.3 استعمال کر سکتا ہوں](#can-i-use-gpt-52-for-daily-tasks-and-codex-53-for-coding)
  - [مجھے "Model …  is not allowed" کیوں نظر آتا ہے اور پھر کوئی جواب نہیں آتا؟](#why-do-i-see-model-is-not-allowed-and-then-no-reply)
  - [Why do I see "Unknown model: minimax/MiniMax-M2.1"?](#why-do-i-see-unknown-model-minimaxminimaxm21)
  - [کیا میں MiniMax کو اپنا ڈیفالٹ اور پیچیدہ کاموں کے لیے OpenAI استعمال کر سکتا ہوں؟](#can-i-use-minimax-as-my-default-and-openai-for-complex-tasks)
  - [کیا opus / sonnet / gpt بلٹ اِن شارٹ کٹس ہیں؟](#are-opus-sonnet-gpt-builtin-shortcuts)
  - [میں ماڈل شارٹ کٹس (aliases) کیسے ڈیفائن یا اووررائیڈ کروں؟](#how-do-i-defineoverride-model-shortcuts-aliases)
  - [میں OpenRouter یا Z.AI جیسے دوسرے پرووائیڈرز سے ماڈلز کیسے شامل کروں؟](#how-do-i-add-models-from-other-providers-like-openrouter-or-zai)
- [ماڈل فیل اوور اور "All models failed"](#model-failover-and-all-models-failed)
  - [فیل اوور کیسے کام کرتا ہے؟](#how-does-failover-work)
  - [اس ایرر کا کیا مطلب ہے؟](#what-does-this-error-mean)
  - [`No credentials found for profile "anthropic:default"` کے لیے فکس چیک لسٹ](#fix-checklist-for-no-credentials-found-for-profile-anthropicdefault)
  - [اس نے Google Gemini کو بھی کیوں آزمایا اور وہ کیوں ناکام ہوا؟](#why-did-it-also-try-google-gemini-and-fail)
- [Auth پروفائلز: یہ کیا ہیں اور انہیں کیسے مینیج کریں](#auth-profiles-what-they-are-and-how-to-manage-them)
  - [Auth پروفائل کیا ہوتا ہے؟](#what-is-an-auth-profile)
  - [عام پروفائل IDs کون سی ہوتی ہیں؟](#what-are-typical-profile-ids)
  - [کیا میں کنٹرول کر سکتا ہوں کہ کون سا auth پروفائل پہلے آزمایا جائے؟](#can-i-control-which-auth-profile-is-tried-first)
  - [OAuth بمقابلہ API key: فرق کیا ہے؟](#oauth-vs-api-key-whats-the-difference)
- 1. [گیٹ وے: پورٹس، "already running"، اور ریموٹ موڈ](#gateway-ports-already-running-and-remote-mode)
  - 2. [گیٹ وے کون سا پورٹ استعمال کرتا ہے؟](#what-port-does-the-gateway-use)
  - 3. [کیوں `openclaw gateway status` میں `Runtime: running` دکھاتا ہے لیکن `RPC probe: failed`؟](#why-does-openclaw-gateway-status-say-runtime-running-but-rpc-probe-failed)
  - 4. [کیوں `openclaw gateway status` میں `Config (cli)` اور `Config (service)` مختلف دکھتے ہیں؟](#why-does-openclaw-gateway-status-show-config-cli-and-config-service-different)
  - 5. ["another gateway instance is already listening" کا کیا مطلب ہے؟](#what-does-another-gateway-instance-is-already-listening-mean)
  - 6. [میں OpenClaw کو ریموٹ موڈ میں کیسے چلاؤں (کلائنٹ کسی اور جگہ موجود گیٹ وے سے جڑتا ہے)؟](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere)
  - 7. [کنٹرول UI میں "unauthorized" دکھاتا ہے (یا بار بار دوبارہ کنیکٹ ہو رہا ہے)۔
    8. اب کیا کروں؟](#the-control-ui-says-unauthorized-or-keeps-reconnecting-what-now) 9. [میں نے `gateway.bind: "tailnet"` سیٹ کیا ہے لیکن یہ bind نہیں ہو پا رہا / کچھ بھی listen نہیں کر رہا](#i-set-gatewaybind-tailnet-but-it-cant-bind-nothing-listens)
  - 10. [کیا میں ایک ہی ہوسٹ پر متعدد گیٹ ویز چلا سکتا ہوں؟](#can-i-run-multiple-gateways-on-the-same-host)
  - 11. ["invalid handshake" / کوڈ 1008 کا کیا مطلب ہے؟](#what-does-invalid-handshake-code-1008-mean)
  - 12. [لاگنگ اور ڈیبگنگ](#logging-and-debugging)
- 13. [لاگز کہاں ہوتے ہیں؟](#where-are-logs)
  - 14. [میں گیٹ وے سروس کو کیسے start/stop/restart کروں؟](#how-do-i-startstoprestart-the-gateway-service)
  - 15. [میں نے ونڈوز پر اپنا ٹرمینل بند کر دیا — میں OpenClaw کو دوبارہ کیسے شروع کروں؟](#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw)
  - 16. [گیٹ وے چل رہا ہے لیکن جوابات کبھی نہیں پہنچتے۔
    17. مجھے کیا چیک کرنا چاہیے؟](#the-gateway-is-up-but-replies-never-arrive-what-should-i-check)
  - 18. ["Disconnected from gateway: no reason" — اب کیا؟](#disconnected-from-gateway-no-reason-what-now) 19. [Telegram میں setMyCommands نیٹ ورک ایررز کے ساتھ فیل ہو جاتا ہے۔
    19. مجھے کیا چیک کرنا چاہیے؟](#telegram-setmycommands-fails-with-network-errors-what-should-i-check)
  - 21. [TUI میں کوئی آؤٹ پٹ نظر نہیں آ رہا۔
    22. مجھے کیا چیک کرنا چاہیے؟](#tui-shows-no-output-what-should-i-check)
  - 23. [میں گیٹ وے کو مکمل طور پر روک کر پھر کیسے شروع کروں؟](#how-do-i-completely-stop-then-start-the-gateway) 24. [ELI5: `openclaw gateway restart` بمقابلہ `openclaw gateway`](#eli5-openclaw-gateway-restart-vs-openclaw-gateway)
  - 25. [جب کوئی چیز فیل ہو جائے تو مزید تفصیلات حاصل کرنے کا تیز ترین طریقہ کیا ہے؟](#whats-the-fastest-way-to-get-more-details-when-something-fails) 26. [میڈیا اور اٹیچمنٹس](#media-and-attachments)
  - 27. [میری اسکل نے ایک تصویر/PDF بنایا، لیکن کچھ بھی بھیجا نہیں گیا](#my-skill-generated-an-imagepdf-but-nothing-was-sent)
  - 28. [سیکیورٹی اور رسائی کنٹرول](#security-and-access-control)
  - 29. [کیا OpenClaw کو inbound DMs کے لیے ایکسپوز کرنا محفوظ ہے؟](#is-it-safe-to-expose-openclaw-to-inbound-dms)
- [Media and attachments](#media-and-attachments)
  - 31. [کیا میرے بوٹ کے لیے الگ ای میل، GitHub اکاؤنٹ یا فون نمبر ہونا چاہیے؟](#should-my-bot-have-its-own-email-github-account-or-phone-number)
- 32. [کیا میں اسے اپنے ٹیکسٹ میسجز پر خودمختاری دے سکتا ہوں، اور کیا یہ محفوظ ہے؟](#can-i-give-it-autonomy-over-my-text-messages-and-is-that-safe)
  - [کیا OpenClaw کو ان باؤنڈ DMs کے لیے ایکسپوز کرنا محفوظ ہے؟](#is-it-safe-to-expose-openclaw-to-inbound-dms)
  - 34. [میں نے Telegram میں `/start` چلایا لیکن مجھے pairing code نہیں ملا](#i-ran-start-in-telegram-but-didnt-get-a-pairing-code)
  - 35. [WhatsApp: کیا یہ میرے کانٹیکٹس کو میسج کرے گا؟
    36. pairing کیسے کام کرتی ہے؟](#whatsapp-will-it-message-my-contacts-how-does-pairing-work)
  - 37. [چیٹ کمانڈز، ٹاسکس کو abort کرنا، اور "یہ رک نہیں رہا"](#chat-commands-aborting-tasks-and-it-wont-stop)
  - [کیا میں ذاتی اسسٹنٹ کے کاموں کے لیے سستے ماڈلز استعمال کر سکتا ہوں؟](#can-i-use-cheaper-models-for-personal-assistant-tasks)
  - 39. [میں چل رہے ٹاسک کو کیسے روکوں/منسوخ کروں؟](#how-do-i-stopcancel-a-running-task)
  - 40. [میں Telegram سے Discord میسج کیسے بھیجوں؟
    41. ("Cross-context messaging denied")](#how-do-i-send-a-discord-message-from-telegram-crosscontext-messaging-denied) 42. [ایسا کیوں لگتا ہے کہ بوٹ تیزی سے آنے والے میسجز کو "نظرانداز" کر دیتا ہے؟](#why-does-it-feel-like-the-bot-ignores-rapidfire-messages)
- 43. اگر کچھ خراب ہو تو پہلے 60 سیکنڈز
  - 44. **فوری اسٹیٹس (پہلا چیک)**
  - 45. تیز لوکل خلاصہ: OS + اپڈیٹ، گیٹ وے/سروس کی رسائی، ایجنٹس/سیشنز، پرووائیڈر کنفیگ + رَن ٹائم مسائل (جب گیٹ وے قابلِ رسائی ہو)۔
  - 46. **چسپاں کیا جا سکنے والی رپورٹ (شیئر کرنے کے لیے محفوظ)** 47. openclaw status --all
  - 48. لاگ ٹیل کے ساتھ صرف-ریڈ تشخیص (ٹوکَنز ریڈیکٹ کیے گئے)۔

## 49. **ڈیمن + پورٹ اسٹیٹ**

1. 50. سپروائزر رَن ٹائم بمقابلہ RPC رسائی، پروب ٹارگٹ URL، اور وہ کنفیگ دکھاتا ہے جو سروس نے غالباً استعمال کی۔

   ```bash
   openclaw status
   ```

   Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when gateway is reachable).

2. **Pasteable report (safe to share)**

   ```bash
   openclaw status --all
   ```

   Read-only diagnosis with log tail (tokens redacted).

3. **Daemon + port state**

   ```bash
   openclaw gateway status
   ```

   Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.

4. **Deep probes**

   ```bash
   openclaw status --deep
   ```

   Runs gateway health checks + provider probes (requires a reachable gateway). See [Health](/gateway/health).

5. **Tail the latest log**

   ```bash
   openclaw logs --follow
   ```

   If RPC is down, fall back to:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).

6. **Run the doctor (repairs)**

   ```bash
   openclaw doctor
   ```

   کنفیگ/اسٹیٹ کی مرمت یا مائیگریٹ کرتا ہے + ہیلتھ چیکس چلاتا ہے۔ See [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).

## فوری آغاز اور پہلی بار سیٹ اپ

### Im stuck whats the fastest way to get unstuck

Use a local AI agent that can **see your machine**. That is far more effective than asking
in Discord, because most "I'm stuck" cases are **local config or environment issues** that
remote helpers cannot inspect.

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

These tools can read the repo, run commands, inspect logs, and help fix your machine-level
setup (PATH, services, permissions, auth files). Give them the **full source checkout** via
the hackable (git) install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

This installs OpenClaw **from a git checkout**, so the agent can read the code + docs and
reason about the exact version you are running. You can always switch back to stable later
by re-running the installer without `--install-method git`.

Tip: ask the agent to **plan and supervise** the fix (step-by-step), then execute only the
necessary commands. اس سے تبدیلیاں چھوٹی رہتی ہیں اور آڈٹ کرنا آسان ہو جاتا ہے۔

If you discover a real bug or fix, please file a GitHub issue or send a PR:
[https://github.com/openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
[https://github.com/openclaw/openclaw/pulls](https://github.com/openclaw/openclaw/pulls)

Start with these commands (share outputs when asking for help):

```bash
openclaw status
openclaw models status
openclaw doctor
```

وہ کیا کرتے ہیں:

- `openclaw status`: گیٹ وے/ایجنٹ کی صحت اور بنیادی کنفیگ کا فوری اسنیپ شاٹ۔
- `openclaw models status`: checks provider auth + model availability.
- `openclaw doctor`: validates and repairs common config/state issues.

Other useful CLI checks: `openclaw status --all`, `openclaw logs --follow`,
`openclaw gateway status`, `openclaw health --verbose`.

Quick debug loop: [First 60 seconds if something's broken](#first-60-seconds-if-somethings-broken).
Install docs: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating).

### What's the recommended way to install and set up OpenClaw

The repo recommends running from source and using the onboarding wizard:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

The wizard can also build UI assets automatically. After onboarding, you typically run the Gateway on port **18789**.

From source (contributors/dev):

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw onboard
```

If you don't have a global install yet, run it via `pnpm openclaw onboard`.

### How do I open the dashboard after onboarding

آن بورڈنگ کے فوراً بعد وزارڈ آپ کے براؤزر کو ایک صاف (نان ٹوکنائزڈ) ڈیش بورڈ URL کے ساتھ کھولتا ہے اور خلاصے میں بھی لنک پرنٹ کرتا ہے۔ Keep that tab open; if it didn't launch, copy/paste the printed URL on the same machine.

### How do I authenticate the dashboard token on localhost vs remote

**Localhost (same machine):**

- Open `http://127.0.0.1:18789/`.
- If it asks for auth, paste the token from `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) into Control UI settings.
- Retrieve it from the gateway host: `openclaw config get gateway.auth.token` (or generate one: `openclaw doctor --generate-gateway-token`).

**Not on localhost:**

- **Tailscale Serve** (recommended): keep bind loopback, run `openclaw gateway --tailscale serve`, open `https://<magicdns>/`. If `gateway.auth.allowTailscale` is `true`, identity headers satisfy auth (no token).
- **Tailnet bind**: run `openclaw gateway --bind tailnet --token "<token>"`, open `http://<tailscale-ip>:18789/`, paste token in dashboard settings.
- **SSH tunnel**: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/` and paste the token in Control UI settings.

See [Dashboard](/web/dashboard) and [Web surfaces](/web) for bind modes and auth details.

### What runtime do I need

Node **>= 22** is required. `pnpm` is recommended. Bun is **not recommended** for the Gateway.

### Does it run on Raspberry Pi

ہاں. The Gateway is lightweight - docs list **512MB-1GB RAM**, **1 core**, and about **500MB**
disk as enough for personal use, and note that a **Raspberry Pi 4 can run it**.

اگر آپ کو اضافی گنجائش چاہیے (لاگز، میڈیا، دیگر سروسز)، تو **2GB تجویز کیا جاتا ہے**، لیکن یہ کوئی سخت کم از کم حد نہیں ہے۔

Tip: a small Pi/VPS can host the Gateway, and you can pair **nodes** on your laptop/phone for
local screen/camera/canvas or command execution. See [Nodes](/nodes).

### Any tips for Raspberry Pi installs

مختصر ورژن: یہ کام کرتا ہے، لیکن کچھ کھردرے کناروں کی توقع رکھیں۔

- Use a **64-bit** OS and keep Node >= 22.
- Prefer the **hackable (git) install** so you can see logs and update fast.
- چینلز/اسکلز کے بغیر شروع کریں، پھر انہیں ایک ایک کر کے شامل کریں۔
- If you hit weird binary issues, it is usually an **ARM compatibility** problem.

Docs: [Linux](/platforms/linux), [Install](/install).

### It is stuck on wake up my friend onboarding will not hatch What now

That screen depends on the Gateway being reachable and authenticated. The TUI also sends
"Wake up, my friend!" automatically on first hatch. اگر آپ وہ لائن **بغیر کسی جواب** کے دیکھیں اور ٹوکنز 0 پر ہی رہیں، تو ایجنٹ کبھی چلا ہی نہیں۔

1. Restart the Gateway:

```bash
openclaw gateway restart
```

2. Check status + auth:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

3. If it still hangs, run:

```bash
openclaw doctor
```

If the Gateway is remote, ensure the tunnel/Tailscale connection is up and that the UI
is pointed at the right Gateway. دیکھیں [Remote access](/gateway/remote)۔

### Can I migrate my setup to a new machine Mac mini without redoing onboarding

ہاں. Copy the **state directory** and **workspace**, then run Doctor once. This
keeps your bot "exactly the same" (memory, session history, auth, and channel
state) as long as you copy **both** locations:

1. Install OpenClaw on the new machine.
2. Copy `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`) from the old machine.
3. Copy your workspace (default: `~/.openclaw/workspace`).
4. Run `openclaw doctor` and restart the Gateway service.

That preserves config, auth profiles, WhatsApp creds, sessions, and memory. If you're in
remote mode, remember the gateway host owns the session store and workspace.

**Important:** if you only commit/push your workspace to GitHub, you're backing
up **memory + bootstrap files**, but **not** session history or auth. Those live
under `~/.openclaw/` (for example `~/.openclaw/agents/<agentId>/sessions/`).

Related: [Migrating](/install/migrating), [Where things live on disk](/help/faq#where-does-openclaw-store-its-data),
[Agent workspace](/concepts/agent-workspace), [Doctor](/gateway/doctor),
[Remote mode](/gateway/remote).

### Where do I see what is new in the latest version

Check the GitHub changelog:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

Newest entries are at the top. If the top section is marked **Unreleased**, the next dated
section is the latest shipped version. اندراجات کو **Highlights**، **Changes** اور
**Fixes** کے تحت گروپ کیا جاتا ہے (ضرورت پڑنے پر docs/دیگر سیکشنز کے ساتھ)۔

### میں docs.openclaw.ai تک رسائی حاصل نہیں کر سکتا، SSL ایرر آ رہا ہے۔ اب کیا کروں؟

کچھ Comcast/Xfinity کنیکشنز غلطی سے Xfinity
Advanced Security کے ذریعے `docs.openclaw.ai` کو بلاک کر دیتے ہیں۔ اسے غیر فعال کریں یا `docs.openclaw.ai` کو allowlist کریں، پھر دوبارہ کوشش کریں۔ مزید
تفصیل: [Troubleshooting](/help/troubleshooting#docsopenclawai-shows-an-ssl-error-comcastxfinity)۔
براہِ کرم یہاں رپورٹ کر کے اسے اَن بلاک کرنے میں ہماری مدد کریں: [https://spa.xfinity.com/check_url_status](https://spa.xfinity.com/check_url_status)۔

اگر پھر بھی آپ سائٹ تک نہیں پہنچ پا رہے، تو docs GitHub پر mirrored ہیں:
[https://github.com/openclaw/openclaw/tree/main/docs](https://github.com/openclaw/openclaw/tree/main/docs)

### stable اور beta میں کیا فرق ہے؟

**Stable** اور **beta** الگ کوڈ لائنیں نہیں بلکہ **npm dist-tags** ہیں:

- `latest` = stable
- `beta` = ٹیسٹنگ کے لیے ابتدائی build

ہم builds کو **beta** پر ship کرتے ہیں، انہیں ٹیسٹ کرتے ہیں، اور جب کوئی build مضبوط ہو جائے تو **اسی ورژن کو `latest` پر promote کر دیتے ہیں**۔ اسی لیے beta اور stable **ایک ہی ورژن** کی طرف اشارہ کر سکتے ہیں۔

دیکھیں کیا بدلا:
[https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md](https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md)

### میں beta ورژن کیسے انسٹال کروں اور beta اور dev میں کیا فرق ہے؟

**Beta** npm dist-tag `beta` ہے (ممکن ہے `latest` سے میچ کرے)۔
**Dev** `main` (git) کی moving head ہے؛ جب publish ہوتی ہے تو npm dist-tag `dev` استعمال کرتی ہے۔

One-liners (macOS/Linux):

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --beta
```

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
```

Windows installer (PowerShell):
[https://openclaw.ai/install.ps1](https://openclaw.ai/install.ps1)

مزید تفصیل: [Development channels](/install/development-channels) اور [Installer flags](/install/installer)۔

### انسٹال اور onboarding میں عام طور پر کتنا وقت لگتا ہے؟

تقریبی رہنمائی:

- **Install:** 2–5 منٹ
- **Onboarding:** 5–15 منٹ، اس بات پر منحصر کہ آپ کتنے چینلز/ماڈلز کنفیگر کرتے ہیں

اگر یہ اٹک جائے تو [Installer stuck](/help/faq#installer-stuck-how-do-i-get-more-feedback)
اور [Im stuck](/help/faq#im-stuck--whats-the-fastest-way-to-get-unstuck) میں دیا گیا تیز debug لوپ استعمال کریں۔

### میں تازہ ترین bits کیسے آزماؤں؟

دو آپشنز:

1. **Dev channel (git checkout):**

```bash
openclaw update --channel dev
```

یہ `main` برانچ پر سوئچ کرتا ہے اور سورس سے اپڈیٹ کرتا ہے۔

2. **Hackable install (installer سائٹ سے):**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

اس سے آپ کو ایک local repo ملتا ہے جسے آپ ایڈٹ کر سکتے ہیں، پھر git کے ذریعے اپڈیٹ کریں۔

اگر آپ دستی طور پر ایک صاف clone پسند کرتے ہیں تو استعمال کریں:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Docs: [Update](/cli/update)، [Development channels](/install/development-channels)،
[Install](/install)۔

### Installer اٹک گیا ہے۔ مجھے مزید feedback کیسے ملے؟

**verbose output** کے ساتھ انسٹالر دوبارہ چلائیں:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --verbose
```

verbose کے ساتھ Beta install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --beta --verbose
```

hackable (git) install کے لیے:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --verbose
```

مزید آپشنز: [Installer flags](/install/installer)۔

### Windows install میں git not found یا openclaw not recognized دکھاتا ہے

Windows کے دو عام مسائل:

**1) npm error spawn git / git not found**

- **Git for Windows** انسٹال کریں اور یقینی بنائیں کہ `git` آپ کے PATH میں موجود ہو۔
- PowerShell بند کریں اور دوبارہ کھولیں، پھر انسٹالر دوبارہ چلائیں۔

**2) انسٹال کے بعد openclaw پہچانا نہیں جا رہا**

- آپ کا npm گلوبل bin فولڈر PATH میں شامل نہیں ہے۔

- پاتھ چیک کریں:

  ```powershell
  npm config get prefix
  ```

- یقینی بنائیں کہ `<prefix>\\bin` PATH میں موجود ہے (زیادہ تر سسٹمز پر یہ `%AppData%\\npm` ہوتا ہے)۔

- PATH اپڈیٹ کرنے کے بعد PowerShell بند کریں اور دوبارہ کھولیں۔

اگر آپ سب سے ہموار Windows سیٹ اپ چاہتے ہیں تو نیٹو Windows کے بجائے **WSL2** استعمال کریں۔
Docs: [Windows](/platforms/windows).

### ڈاکس نے میرے سوال کا جواب نہیں دیا، میں بہتر جواب کیسے حاصل کروں؟

**hackable (git) install** استعمال کریں تاکہ آپ کے پاس مکمل سورس اور ڈاکس لوکل ہوں، پھر اپنے بوٹ (یا Claude/Codex) سے _اسی فولڈر سے_ سوال کریں تاکہ وہ ریپو پڑھ کر درست جواب دے سکے۔

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

مزید تفصیل: [Install](/install) اور [Installer flags](/install/installer).

### میں Linux پر OpenClaw کیسے انسٹال کروں؟

مختصر جواب: Linux گائیڈ فالو کریں، پھر آن بورڈنگ ویزرڈ چلائیں۔

- Linux کا تیز راستہ + سروس انسٹال: [Linux](/platforms/linux).
- مکمل واک تھرو: [Getting Started](/start/getting-started).
- انسٹالر + اپڈیٹس: [Install & updates](/install/updating).

### میں VPS پر OpenClaw کیسے انسٹال کروں؟

کوئی بھی Linux VPS کام کرے گا۔ سرور پر انسٹال کریں، پھر Gateway تک پہنچنے کے لیے SSH/Tailscale استعمال کریں۔

گائیڈز: [exe.dev](/install/exe-dev), [Hetzner](/install/hetzner), [Fly.io](/install/fly).
ریموٹ رسائی: [Gateway remote](/gateway/remote).

### cloudVPS انسٹال گائیڈز کہاں ہیں؟

ہم عام فراہم کنندگان کے ساتھ ایک **hosting hub** رکھتے ہیں۔ ایک منتخب کریں اور گائیڈ فالو کریں:

- [VPS hosting](/vps) (تمام فراہم کنندگان ایک جگہ)
- [Fly.io](/install/fly)
- [Hetzner](/install/hetzner)
- [exe.dev](/install/exe-dev)

کلاؤڈ میں یہ کیسے کام کرتا ہے: **Gateway سرور پر چلتا ہے**، اور آپ اپنے لیپ ٹاپ/فون سے Control UI (یا Tailscale/SSH) کے ذریعے اس تک رسائی حاصل کرتے ہیں۔ آپ کی اسٹیٹ اور ورک اسپیس سرور پر رہتی ہے، اس لیے ہوسٹ کو سورس آف ٹروتھ سمجھیں اور اس کا بیک اپ رکھیں۔

آپ اس کلاؤڈ Gateway کے ساتھ **nodes** (Mac/iOS/Android/headless) پیئر کر سکتے ہیں تاکہ لوکل اسکرین/کیمرا/کینوس تک رسائی حاصل ہو یا اپنے لیپ ٹاپ پر کمانڈز چلائیں، جبکہ Gateway کلاؤڈ میں ہی رہے۔

Hub: [Platforms](/platforms). ریموٹ رسائی: [Gateway remote](/gateway/remote).
Nodes: [Nodes](/nodes), [Nodes CLI](/cli/nodes).

### کیا میں OpenClaw سے خود کو اپڈیٹ کرنے کو کہہ سکتا ہوں؟

مختصر جواب: **ممکن ہے، لیکن تجویز نہیں کیا جاتا**۔ اپڈیٹ فلو Gateway کو ری اسٹارٹ کر سکتا ہے (جس سے فعال سیشن ختم ہو جاتا ہے)، صاف git checkout کی ضرورت پڑ سکتی ہے، اور تصدیق کے لیے پرامپٹ آ سکتا ہے۔ زیادہ محفوظ طریقہ: آپریٹر کے طور پر شیل سے اپڈیٹس چلائیں۔

CLI استعمال کریں:

```bash
openclaw update
openclaw update status
openclaw update --channel stable|beta|dev
openclaw update --tag <dist-tag|version>
openclaw update --no-restart
```

اگر آپ کو لازمی طور پر کسی ایجنٹ سے آٹومیٹ کرنا ہو:

```bash
openclaw update --yes --no-restart
openclaw gateway restart
```

Docs: [Update](/cli/update), [Updating](/install/updating).

### آن بورڈنگ ویزرڈ اصل میں کیا کرتا ہے؟

`openclaw onboard` تجویز کردہ سیٹ اپ راستہ ہے۔ **لوکل موڈ** میں یہ آپ کو درج ذیل مراحل سے گزارتا ہے:

- **ماڈل/آتھنٹیکیشن سیٹ اپ** (Claude سبسکرپشنز کے لیے Anthropic **setup-token** تجویز کیا جاتا ہے، OpenAI Codex OAuth سپورٹڈ ہے، API keys اختیاری ہیں، LM Studio کے لوکل ماڈلز سپورٹڈ ہیں)
- **ورک اسپیس** لوکیشن + بوٹ اسٹرَیپ فائلز
- **Gateway سیٹنگز** (bind/port/auth/tailscale)
- **Providers** (WhatsApp, Telegram, Discord, Mattermost (plugin), Signal, iMessage)
- **Daemon install** (LaunchAgent on macOS; systemd user unit on Linux/WSL2)
- **Health checks** and **skills** selection

It also warns if your configured model is unknown or missing auth.

### Do I need a Claude or OpenAI subscription to run this

نہیں. You can run OpenClaw with **API keys** (Anthropic/OpenAI/others) or with
**local-only models** so your data stays on your device. Subscriptions (Claude
Pro/Max or OpenAI Codex) are optional ways to authenticate those providers.

Docs: [Anthropic](/providers/anthropic), [OpenAI](/providers/openai),
[Local models](/gateway/local-models), [Models](/concepts/models).

### Can I use Claude Max subscription without an API key

ہاں. You can authenticate with a **setup-token**
instead of an API key. This is the subscription path.

Claude Pro/Max subscriptions **do not include an API key**, so this is the
correct approach for subscription accounts. Important: you must verify with
Anthropic that this usage is allowed under their subscription policy and terms.
If you want the most explicit, supported path, use an Anthropic API key.

### How does Anthropic setuptoken auth work

`claude setup-token` generates a **token string** via the Claude Code CLI (it is not available in the web console). You can run it on **any machine**. Choose **Anthropic token (paste setup-token)** in the wizard or paste it with `openclaw models auth paste-token --provider anthropic`. The token is stored as an auth profile for the **anthropic** provider and used like an API key (no auto-refresh). More detail: [OAuth](/concepts/oauth).

### Where do I find an Anthropic setuptoken

It is **not** in the Anthropic Console. The setup-token is generated by the **Claude Code CLI** on **any machine**:

```bash
claude setup-token
```

Copy the token it prints, then choose **Anthropic token (paste setup-token)** in the wizard. If you want to run it on the gateway host, use `openclaw models auth setup-token --provider anthropic`. If you ran `claude setup-token` elsewhere, paste it on the gateway host with `openclaw models auth paste-token --provider anthropic`. See [Anthropic](/providers/anthropic).

### Do you support Claude subscription auth (Claude Pro or Max)

Yes - via **setup-token**. OpenClaw no longer reuses Claude Code CLI OAuth tokens; use a setup-token or an Anthropic API key. Generate the token anywhere and paste it on the gateway host. See [Anthropic](/providers/anthropic) and [OAuth](/concepts/oauth).

Note: Claude subscription access is governed by Anthropic's terms. For production or multi-user workloads, API keys are usually the safer choice.

### Why am I seeing HTTP 429 ratelimiterror from Anthropic

That means your **Anthropic quota/rate limit** is exhausted for the current window. If you
use a **Claude subscription** (setup-token or Claude Code OAuth), wait for the window to
reset or upgrade your plan. If you use an **Anthropic API key**, check the Anthropic Console
for usage/billing and raise limits as needed.

Tip: set a **fallback model** so OpenClaw can keep replying while a provider is rate-limited.
See [Models](/cli/models) and [OAuth](/concepts/oauth).

### Is AWS Bedrock supported

Yes - via pi-ai's **Amazon Bedrock (Converse)** provider with **manual config**. You must supply AWS credentials/region on the gateway host and add a Bedrock provider entry in your models config. See [Amazon Bedrock](/providers/bedrock) and [Model providers](/providers/models). If you prefer a managed key flow, an OpenAI-compatible proxy in front of Bedrock is still a valid option.

### How does Codex auth work

OpenClaw supports **OpenAI Code (Codex)** via OAuth (ChatGPT sign-in). The wizard can run the OAuth flow and will set the default model to `openai-codex/gpt-5.3-codex` when appropriate. See [Model providers](/concepts/model-providers) and [Wizard](/start/wizard).

### Do you support OpenAI subscription auth Codex OAuth

ہاں. 1. OpenClaw **OpenAI Code (Codex) subscription OAuth** کو مکمل طور پر سپورٹ کرتا ہے۔ 2. آن بورڈنگ وزرڈ
آپ کے لیے OAuth فلو چلا سکتا ہے۔

3. دیکھیں [OAuth](/concepts/oauth)، [Model providers](/concepts/model-providers)، اور [Wizard](/start/wizard)۔

### 4. میں Gemini CLI OAuth کیسے سیٹ اپ کروں

5. Gemini CLI **plugin auth flow** استعمال کرتا ہے، `openclaw.json` میں client id یا secret نہیں۔

6. مراحل:

1. 7. پلگ ان فعال کریں: `openclaw plugins enable google-gemini-cli-auth`
2. لاگ اِن: `openclaw models auth login --provider google-gemini-cli --set-default`

8) یہ گیٹ وے ہوسٹ پر auth profiles میں OAuth ٹوکنز محفوظ کرتا ہے۔ 9. تفصیلات: [Model providers](/concepts/model-providers)۔

### 10. کیا casual چیٹس کے لیے لوکل ماڈل ٹھیک ہے

11. عام طور پر نہیں۔ 12. OpenClaw کو بڑا context اور مضبوط safety درکار ہوتی ہے؛ چھوٹے کارڈز truncate کرتے ہیں اور لیک کرتے ہیں۔ 13. اگر لازمی ہو تو لوکلی **سب سے بڑا** MiniMax M2.1 build چلائیں (LM Studio) اور دیکھیں [/gateway/local-models](/gateway/local-models)۔ 14. چھوٹے/quantized ماڈلز prompt‑injection کے خطرے کو بڑھاتے ہیں - دیکھیں [Security](/gateway/security)۔

### 15. میں hosted ماڈل ٹریفک کو کسی مخصوص ریجن میں کیسے رکھوں

16. region‑pinned endpoints منتخب کریں۔ 17. OpenRouter MiniMax، Kimi، اور GLM کے لیے US‑hosted آپشنز فراہم کرتا ہے؛ ڈیٹا کو ریجن میں رکھنے کے لیے US‑hosted variant منتخب کریں۔ 18. آپ `models.mode: "merge"` استعمال کر کے Anthropic/OpenAI کو بھی ان کے ساتھ لسٹ کر سکتے ہیں تاکہ fallbacks دستیاب رہیں جبکہ آپ منتخب کردہ regioned provider کی پابندی بھی ہو۔

### 19. کیا مجھے یہ انسٹال کرنے کے لیے Mac Mini خریدنا ہوگا

نہیں. 20. OpenClaw macOS یا Linux پر چلتا ہے (Windows پر WSL2 کے ذریعے)۔ 21. Mac mini اختیاری ہے - کچھ لوگ
ہمیشہ آن ہوسٹ کے طور پر ایک خریدتے ہیں، لیکن ایک چھوٹا VPS، ہوم سرور، یا Raspberry Pi‑class باکس بھی کام کرتا ہے۔

آپ کو صرف **macOS-صرف ٹولز** کے لیے ہی Mac کی ضرورت ہوتی ہے۔ iMessage کے لیے [BlueBubbles](/channels/bluebubbles) استعمال کریں (تجویز کردہ) — BlueBubbles سرور کسی بھی Mac پر چلتا ہے، اور گیٹ وے Linux یا کہیں اور چل سکتا ہے۔ 24. اگر آپ کو دیگر macOS‑only ٹولز چاہئیں تو Gateway کو Mac پر چلائیں یا macOS node جوڑیں۔

25. Docs: [BlueBubbles](/channels/bluebubbles)، [Nodes](/nodes)، [Mac remote mode](/platforms/mac/remote)۔

### 26. کیا iMessage سپورٹ کے لیے مجھے Mac mini درکار ہے

27. آپ کو Messages میں سائن اِن کیا ہوا **کوئی macOS ڈیوائس** درکار ہے۔ 28. یہ **ضروری نہیں** کہ Mac mini ہو -
    کوئی بھی Mac کام کرتا ہے۔ 29. iMessage کے لیے **[BlueBubbles](/channels/bluebubbles) استعمال کریں** (تجویز کردہ) - BlueBubbles سرور macOS پر چلتا ہے، جبکہ Gateway Linux یا کہیں اور چل سکتا ہے۔

30. عام سیٹ اپس:

- 31. Gateway کو Linux/VPS پر چلائیں، اور BlueBubbles سرور کو کسی بھی ایسے Mac پر چلائیں جو Messages میں سائن اِن ہو۔
- 32. اگر آپ سب سے سادہ single‑machine سیٹ اپ چاہتے ہیں تو سب کچھ Mac پر چلائیں۔

33. Docs: [BlueBubbles](/channels/bluebubbles)، [Nodes](/nodes)،
    [Mac remote mode](/platforms/mac/remote)۔

### 34. اگر میں OpenClaw چلانے کے لیے Mac mini خریدوں تو کیا میں اسے اپنے MacBook Pro سے کنیکٹ کر سکتا ہوں

ہاں. 35. **Mac mini Gateway چلا سکتا ہے**، اور آپ کا MacBook Pro
**node** (companion device) کے طور پر کنیکٹ ہو سکتا ہے۔ 36. Nodes Gateway نہیں چلاتے - وہ اضافی
صلاحیتیں فراہم کرتے ہیں جیسے screen/camera/canvas اور اس ڈیوائس پر `system.run`۔

عام پیٹرن:

- Mac mini پر گیٹ وے (ہمیشہ آن)۔
- 39. MacBook Pro macOS ایپ یا node host چلاتا ہے اور Gateway کے ساتھ pair کرتا ہے۔
- 40. اسے دیکھنے کے لیے `openclaw nodes status` / `openclaw nodes list` استعمال کریں۔

دستاویزات: [Nodes](/nodes)، [Nodes CLI](/cli/nodes).

### 41. کیا میں Bun استعمال کر سکتا ہوں

42. Bun **تجویز نہیں کیا جاتا**۔ 43. ہمیں runtime bugs نظر آتے ہیں، خاص طور پر WhatsApp اور Telegram کے ساتھ۔
43. مستحکم gateways کے لیے **Node** استعمال کریں۔

45. اگر پھر بھی آپ Bun کے ساتھ تجربہ کرنا چاہتے ہیں تو اسے non‑production gateway پر کریں
    بغیر WhatsApp/Telegram کے۔

### 46. Telegram میں allowFrom میں کیا جاتا ہے

47. `channels.telegram.allowFrom` **انسانی بھیجنے والے کا Telegram user ID** ہوتا ہے (numeric، تجویز کردہ) یا `@username`۔ 48. یہ bot username نہیں ہوتا۔

محفوظ (بغیر تھرڈ پارٹی بوٹ):

- 49. اپنے bot کو DM کریں، پھر `openclaw logs --follow` چلائیں اور `from.id` پڑھیں۔

50. Official Bot API:

- DM your bot, then call `https://api.telegram.org/bot<bot_token>/getUpdates` and read `message.from.id`.

تھرڈ پارٹی (کم پرائیویٹ):

- DM `@userinfobot` or `@getidsbot`.

See [/channels/telegram](/channels/telegram#access-control-dms--groups).

### کیا متعدد لوگ مختلف OpenClaw انسٹینسز کے ساتھ ایک ہی WhatsApp نمبر استعمال کر سکتے ہیں

Yes, via **multi-agent routing**. Bind each sender's WhatsApp **DM** (peer `kind: "dm"`, sender E.164 like `+15551234567`) to a different `agentId`, so each person gets their own workspace and session store. Replies still come from the **same WhatsApp account**, and DM access control (`channels.whatsapp.dmPolicy` / `channels.whatsapp.allowFrom`) is global per WhatsApp account. See [Multi-Agent Routing](/concepts/multi-agent) and [WhatsApp](/channels/whatsapp).

### Can I run a fast chat agent and an Opus for coding agent

ہاں. ملٹی-ایجنٹ روٹنگ استعمال کریں: ہر ایجنٹ کو اس کا اپنا ڈیفالٹ ماڈل دیں، پھر ان باؤنڈ روٹس (پرووائیڈر اکاؤنٹ یا مخصوص پیئرز) کو ہر ایجنٹ سے بائنڈ کریں۔ Example config lives in [Multi-Agent Routing](/concepts/multi-agent). See also [Models](/concepts/models) and [Configuration](/gateway/configuration).

### Does Homebrew work on Linux

ہاں. Homebrew supports Linux (Linuxbrew). Quick setup:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.profile
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install <formula>
```

If you run OpenClaw via systemd, ensure the service PATH includes `/home/linuxbrew/.linuxbrew/bin` (or your brew prefix) so `brew`-installed tools resolve in non-login shells.
Recent builds also prepend common user bin dirs on Linux systemd services (for example `~/.local/bin`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`) and honor `PNPM_HOME`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `NVM_DIR`, and `FNM_DIR` when set.

### What's the difference between the hackable git install and npm install

- **Hackable (git) install:** full source checkout, editable, best for contributors.
  You run builds locally and can patch code/docs.
- **npm install:** global CLI install, no repo, best for "just run it."
  Updates come from npm dist-tags.

Docs: [Getting started](/start/getting-started), [Updating](/install/updating).

### Can I switch between npm and git installs later

ہاں. Install the other flavor, then run Doctor so the gateway service points at the new entrypoint.
یہ **آپ کا ڈیٹا ڈیلیٹ نہیں کرتا** — یہ صرف OpenClaw کے کوڈ انسٹال کو تبدیل کرتا ہے۔ Your state
(`~/.openclaw`) and workspace (`~/.openclaw/workspace`) stay untouched.

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

Doctor detects a gateway service entrypoint mismatch and offers to rewrite the service config to match the current install (use `--repair` in automation).

Backup tips: see [Backup strategy](/help/faq#whats-the-recommended-backup-strategy).

### Should I run the Gateway on my laptop or a VPS

Short answer: **if you want 24/7 reliability, use a VPS**. If you want the
lowest friction and you're okay with sleep/restarts, run it locally.

**Laptop (local Gateway)**

- **فوائد:** کوئی سرور لاگت نہیں، لوکل فائلز تک براہِ راست رسائی، لائیو براؤزر ونڈو۔
- **Cons:** sleep/network drops = disconnects, OS updates/reboots interrupt, must stay awake.

**VPS / cloud**

- **Pros:** always-on, stable network, no laptop sleep issues, easier to keep running.
- **Cons:** often run headless (use screenshots), remote file access only, you must SSH for updates.

**OpenClaw-specific note:** WhatsApp/Telegram/Slack/Mattermost (plugin)/Discord all work fine from a VPS. The only real trade-off is **headless browser** vs a visible window. See [Browser](/tools/browser).

**Recommended default:** VPS if you had gateway disconnects before. Local is great when you're actively using the Mac and want local file access or UI automation with a visible browser.

### How important is it to run OpenClaw on a dedicated machine

Not required, but **recommended for reliability and isolation**.

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

### Can I run OpenClaw in a VM and what are the requirements

ہاں. Treat a VM the same as a VPS: it needs to be always on, reachable, and have enough
RAM for the Gateway and any channels you enable.

بنیادی رہنمائی:

- **بالکل کم از کم:** 1 vCPU، 1GB RAM۔
- **Recommended:** 2GB RAM or more if you run multiple channels, browser automation, or media tools.
- **OS:** Ubuntu LTS or another modern Debian/Ubuntu.

If you are on Windows, **WSL2 is the easiest VM style setup** and has the best tooling
compatibility. See [Windows](/platforms/windows), [VPS hosting](/vps).
If you are running macOS in a VM, see [macOS VM](/install/macos-vm).

## What is OpenClaw?

### What is OpenClaw in one paragraph

OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost (plugin), Discord, Google Chat, Signal, iMessage, WebChat) and can also do voice + a live Canvas on supported platforms. **گیٹ وے** ہمیشہ آن کنٹرول پلین ہے؛ اسسٹنٹ ہی پروڈکٹ ہے۔

### What's the value proposition

OpenClaw is not "just a Claude wrapper." It's a **local-first control plane** that lets you run a
capable assistant on **your own hardware**, reachable from the chat apps you already use, with
stateful sessions, memory, and tools - without handing control of your workflows to a hosted
SaaS.

نمایاں نکات:

- **Your devices, your data:** run the Gateway wherever you want (Mac, Linux, VPS) and keep the
  workspace + session history local.
- **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
  plus mobile voice and Canvas on supported platforms.
- **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing
  and failover.
- **Local-only option:** run local models so **all data can stay on your device** if you want.
- **Multi-agent routing:** separate agents per channel, account, or task, each with its own
  workspace and defaults.
- **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
[Memory](/concepts/memory).

### I just set it up what should I do first

Good first projects:

- Build a website (WordPress, Shopify, or a simple static site).
- Prototype a mobile app (outline, screens, API plan).
- Organize files and folders (cleanup, naming, tagging).
- Connect Gmail and automate summaries or follow ups.

It can handle large tasks, but it works best when you split them into phases and
use sub agents for parallel work.

### What are the top five everyday use cases for OpenClaw

Everyday wins usually look like:

- **Personal briefings:** summaries of inbox, calendar, and news you care about.
- **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
- **Reminders and follow ups:** cron or heartbeat driven nudges and checklists.
- **Browser automation:** filling forms, collecting data, and repeating web tasks.
- **Cross device coordination:** send a task from your phone, let the Gateway run it on a server, and get the result back in chat.

### کیا OpenClaw ایک SaaS کے لیے لیڈ جن آؤٹ ریچ اشتہارات اور بلاگز میں مدد کر سکتا ہے

ہاں، **تحقیق، کوالیفیکیشن، اور ڈرافٹنگ** کے لیے۔ یہ سائٹس اسکین کر سکتا ہے، شارٹ لسٹس بنا سکتا ہے،
ممکنہ کلائنٹس کا خلاصہ کر سکتا ہے، اور آؤٹ ریچ یا اشتہاری کاپی کے ڈرافٹس لکھ سکتا ہے۔

**آؤٹ ریچ یا اشتہاری مہمات** کے لیے، انسان کو عمل میں شامل رکھیں۔ اسپام سے بچیں، مقامی قوانین اور
پلیٹ فارم پالیسیوں کی پیروی کریں، اور بھیجنے سے پہلے ہر چیز کا جائزہ لیں۔ سب سے محفوظ طریقہ یہ ہے کہ
OpenClaw ڈرافٹ تیار کرے اور آپ منظوری دیں۔

Docs: [Security](/gateway/security).

### ویب ڈویلپمنٹ کے لیے Claude Code کے مقابلے میں کیا فوائد ہیں

OpenClaw ایک **ذاتی معاون** اور کوآرڈینیشن لیئر ہے، IDE کا متبادل نہیں۔ تیز ترین براہِ راست کوڈنگ لوپ کے لیے ریپو کے اندر Claude Code یا Codex استعمال کریں۔ جب آپ کو پائیدار میموری، کراس ڈیوائس رسائی، اور ٹول آرکسٹریشن درکار ہو تو OpenClaw استعمال کریں۔

فوائد:

- **سیشنز کے درمیان مستقل میموری + ورک اسپیس**
- **ملٹی پلیٹ فارم رسائی** (WhatsApp، Telegram، TUI، WebChat)
- **ٹول آرکسٹریشن** (براؤزر، فائلیں، شیڈولنگ، ہکس)
- **ہمیشہ فعال گیٹ وے** (VPS پر چلائیں، کہیں سے بھی تعامل کریں)
- **نوڈز** مقامی براؤزر/اسکرین/کیمرہ/ایگزیک کے لیے

شوکیس: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

## اسکلز اور آٹومیشن

### میں ریپو کو گندا کیے بغیر اسکلز کو کس طرح کسٹمائز کروں

ریپو کی کاپی میں ترمیم کرنے کے بجائے منیجڈ اووررائیڈز استعمال کریں۔ اپنی تبدیلیاں `~/.openclaw/skills/<name>/SKILL.md` میں رکھیں (یا `~/.openclaw/openclaw.json` میں `skills.load.extraDirs` کے ذریعے ایک فولڈر شامل کریں)۔ ترجیحی ترتیب `<workspace>/skills` > `~/.openclaw/skills` > بنڈلڈ ہے، لہٰذا منیجڈ اووررائیڈز گِٹ کو چھیڑے بغیر غالب رہتے ہیں۔ صرف وہی ترامیم جو اپ اسٹریم کے قابل ہوں ریپو میں ہونی چاہئیں اور PRs کی صورت میں بھیجی جائیں۔

### کیا میں کسی کسٹم فولڈر سے اسکلز لوڈ کر سکتا ہوں

ہاں. `~/.openclaw/openclaw.json` میں `skills.load.extraDirs` کے ذریعے اضافی ڈائریکٹریز شامل کریں (سب سے کم ترجیح)۔ ڈیفالٹ ترجیحی ترتیب یہی رہتی ہے: `<workspace>/skills` → `~/.openclaw/skills` → بنڈلڈ → `skills.load.extraDirs`۔ `clawhub` ڈیفالٹ طور پر `./skills` میں انسٹال کرتا ہے، جسے OpenClaw `<workspace>/skills` کے طور پر سمجھتا ہے۔

### میں مختلف کاموں کے لیے مختلف ماڈلز کیسے استعمال کر سکتا ہوں

آج سپورٹڈ پیٹرنز یہ ہیں:

- **کرون جابز**: الگ تھلگ جابز ہر جاب کے لیے `model` اووررائیڈ سیٹ کر سکتی ہیں۔
- **سب ایجنٹس**: کاموں کو مختلف ڈیفالٹ ماڈلز والے الگ ایجنٹس کی طرف روٹ کریں۔
- **آن ڈیمانڈ سوئچ**: موجودہ سیشن کا ماڈل کسی بھی وقت بدلنے کے لیے `/model` استعمال کریں۔

[Cron jobs](/automation/cron-jobs)، [Multi-Agent Routing](/concepts/multi-agent)، اور [Slash commands](/tools/slash-commands) دیکھیں۔

### بھاری کام کے دوران بوٹ فریز ہو جاتا ہے، میں اسے کیسے آف لوڈ کروں

طویل یا متوازی کاموں کے لیے **سب ایجنٹس** استعمال کریں۔ سب ایجنٹس اپنی الگ سیشن میں چلتے ہیں،
خلاصہ واپس کرتے ہیں، اور آپ کی مین چیٹ کو ریسپانسیو رکھتے ہیں۔

اپنے بوٹ سے کہیں "اس کام کے لیے ایک سب ایجنٹ اسپان کریں" یا `/subagents` استعمال کریں۔
چیٹ میں `/status` استعمال کریں تاکہ دیکھ سکیں کہ گیٹ وے اس وقت کیا کر رہا ہے (اور آیا وہ مصروف ہے یا نہیں)۔

ٹوکن ٹِپ: طویل کام اور سب ایجنٹس دونوں ٹوکن استعمال کرتے ہیں۔ اگر لاگت تشویش کا باعث ہو تو،
`agents.defaults.subagents.model` کے ذریعے سب ایجنٹس کے لیے سستا ماڈل سیٹ کریں۔

Docs: [Sub-agents](/tools/subagents).

### کرون یا ریمائنڈرز فائر نہیں ہو رہے، مجھے کیا چیک کرنا چاہیے

کرون گیٹ وے پروسیس کے اندر چلتا ہے۔ اگر گیٹ وے مسلسل نہیں چل رہا،
تو شیڈیولڈ جابز نہیں چلیں گی۔

چیک لسٹ:

- یقینی بنائیں کہ کرون فعال ہے (`cron.enabled`) اور `OPENCLAW_SKIP_CRON` سیٹ نہیں ہے۔
- چیک کریں کہ گیٹ وے 24/7 چل رہا ہے (کوئی سلیپ/ری اسٹارٹس نہیں)۔
- جاب کے لیے ٹائم زون سیٹنگز کی تصدیق کریں (`--tz` بمقابلہ ہوسٹ ٹائم زون)۔

ڈی بگ:

```bash
openclaw cron run <jobId> --force
openclaw cron runs --id <jobId> --limit 50
```

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat).

### How do I install skills on Linux

Use **ClawHub** (CLI) or drop skills into your workspace. The macOS Skills UI isn't available on Linux.
Browse skills at [https://clawhub.com](https://clawhub.com).

Install the ClawHub CLI (pick one package manager):

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

### Can OpenClaw run tasks on a schedule or continuously in the background

ہاں. Use the Gateway scheduler:

- **Cron jobs** for scheduled or recurring tasks (persist across restarts).
- **Heartbeat** for "main session" periodic checks.
- **Isolated jobs** for autonomous agents that post summaries or deliver to chats.

Docs: [Cron jobs](/automation/cron-jobs), [Cron vs Heartbeat](/automation/cron-vs-heartbeat),
[Heartbeat](/gateway/heartbeat).

### Can I run Apple macOS-only skills from Linux?

Not directly. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and skills only appear in the system prompt when they are eligible on the **Gateway host**. On Linux, `darwin`-only skills (like `apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.

You have three supported patterns:

**آپشن A - گیٹ وے کو Mac پر چلائیں (سب سے آسان).**
macOS بائنریز جہاں موجود ہوں وہاں گیٹ وے چلائیں، پھر Linux سے [remote mode](#how-do-i-run-openclaw-in-remote-mode-client-connects-to-a-gateway-elsewhere) میں یا Tailscale کے ذریعے کنیکٹ کریں۔ The skills load normally because the Gateway host is macOS.

**Option B - use a macOS node (no SSH).**
Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. جب مطلوبہ بائنریز نوڈ پر موجود ہوں تو OpenClaw macOS-صرف اسکلز کو اہل سمجھ سکتا ہے۔ The agent runs those skills via the `nodes` tool. If you choose "Always Ask", approving "Always Allow" in the prompt adds that command to the allowlist.

**Option C - proxy macOS binaries over SSH (advanced).**
Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac. پھر اسکل کو اوور رائیڈ کریں تاکہ Linux کی اجازت مل جائے اور وہ اہل رہے۔

1. بائنری کے لیے ایک SSH ریپر بنائیں (مثال: Apple Notes کے لیے `memo`):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
   ```

2. Linux ہوسٹ پر ریپر کو `PATH` میں رکھیں (مثلاً `~/bin/memo`)۔

3. Override the skill metadata (workspace or `~/.openclaw/skills`) to allow Linux:

   ```markdown
   ---
   name: apple-notes
   description: Manage Apple Notes via the memo CLI on macOS.
   metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
   ---
   ```

4. Start a new session so the skills snapshot refreshes.

### Do you have a Notion or HeyGen integration

Not built-in today.

Options:

- **Custom skill / plugin:** best for reliable API access (Notion/HeyGen both have APIs).
- **براؤزر آٹومیشن:** بغیر کوڈ کے کام کرتی ہے لیکن سست اور زیادہ نازک ہوتی ہے۔

اگر آپ فی کلائنٹ کانٹیکسٹ رکھنا چاہتے ہیں (ایجنسی ورک فلو)، تو ایک سادہ پیٹرن یہ ہے:

- One Notion page per client (context + preferences + active work).
- Ask the agent to fetch that page at the start of a session.

If you want a native integration, open a feature request or build a skill
targeting those APIs.

Install skills:

```bash
clawhub install <skill-slug>
clawhub update --all
```

ClawHub installs into `./skills` under your current directory (or falls back to your configured OpenClaw workspace); OpenClaw treats that as `<workspace>/skills` on the next session. For shared skills across agents, place them in `~/.openclaw/skills/<name>/SKILL.md`. Some skills expect binaries installed via Homebrew; on Linux that means Linuxbrew (see the Homebrew Linux FAQ entry above). See [Skills](/tools/skills) and [ClawHub](/tools/clawhub).

### How do I install the Chrome extension for browser takeover

Use the built-in installer, then load the unpacked extension in Chrome:

```bash
openclaw browser extension install
openclaw browser extension path
```

Then Chrome → `chrome://extensions` → enable "Developer mode" → "Load unpacked" → pick that folder.

Full guide (including remote Gateway + security notes): [Chrome extension](/tools/chrome-extension)

If the Gateway runs on the same machine as Chrome (default setup), you usually **do not** need anything extra.
اگر Gateway کہیں اور چل رہا ہو، تو براؤزر مشین پر node host چلائیں تاکہ Gateway براؤزر ایکشنز کو پروکسی کر سکے۔
You still need to click the extension button on the tab you want to control (it doesn't auto-attach).

## Sandboxing and memory

### Is there a dedicated sandboxing doc

ہاں. See [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).

### Docker feels limited How do I enable full features

The default image is security-first and runs as the `node` user, so it does not
include system packages, Homebrew, or bundled browsers. For a fuller setup:

- Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.
- Bake system deps into the image with `OPENCLAW_DOCKER_APT_PACKAGES`.
- Install Playwright browsers via the bundled CLI:
  `node /app/node_modules/playwright-core/cli.js install chromium`
- Set `PLAYWRIGHT_BROWSERS_PATH` and ensure the path is persisted.

Docs: [Docker](/install/docker), [Browser](/tools/browser).

**Can I keep DMs personal but make groups public sandboxed with one agent**

Yes - if your private traffic is **DMs** and your public traffic is **groups**.

Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in Docker, while the main DM session stays on-host. Then restrict what tools are available in sandboxed sessions via `tools.sandbox.tools`.

Setup walkthrough + example config: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

Key config reference: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)

### How do I bind a host folder into the sandbox

Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls. See [Sandboxing](/gateway/sandboxing#custom-bind-mounts) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) for examples and safety notes.

### How does memory work

OpenClaw memory is just Markdown files in the agent workspace:

- Daily notes in `memory/YYYY-MM-DD.md`
- Curated long-term notes in `MEMORY.md` (main/private sessions only)

OpenClaw also runs a **silent pre-compaction memory flush** to remind the model
to write durable notes before auto-compaction. This only runs when the workspace
is writable (read-only sandboxes skip it). دیکھیں [Memory](/concepts/memory)۔

### Memory keeps forgetting things How do I make it stick

Ask the bot to **write the fact to memory**. Long-term notes belong in `MEMORY.md`,
short-term context goes into `memory/YYYY-MM-DD.md`.

This is still an area we are improving. It helps to remind the model to store memories;
it will know what to do. If it keeps forgetting, verify the Gateway is using the same
workspace on every run.

Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

### Does semantic memory search require an OpenAI API key

Only if you use **OpenAI embeddings**. Codex OAuth covers chat/completions and
does **not** grant embeddings access, so **signing in with Codex (OAuth or the
Codex CLI login)** does not help for semantic memory search. OpenAI embeddings
still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

If you don't set a provider explicitly, OpenClaw auto-selects a provider when it
can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).
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

Memory files live on disk and persist until you delete them. حد آپ کی
اسٹوریج ہے، ماڈل نہیں۔ **سیشن کانٹیکسٹ** اب بھی ماڈل کے کانٹیکسٹ ونڈو کے ذریعے محدود ہے، اس لیے طویل گفتگو کمپیکٹ یا مختصر ہو سکتی ہے۔ اسی لیے
میموری سرچ موجود ہے — یہ صرف متعلقہ حصوں کو دوبارہ کانٹیکسٹ میں لاتی ہے۔

دستاویزات: [Memory](/concepts/memory)، [Context](/concepts/context)۔

## ڈسک پر چیزیں کہاں رہتی ہیں

### کیا OpenClaw کے ساتھ استعمال ہونے والا تمام ڈیٹا مقامی طور پر محفوظ ہوتا ہے

نہیں — **OpenClaw کی اسٹیٹ مقامی ہوتی ہے**، لیکن **بیرونی سروسز اب بھی وہی دیکھتی ہیں جو آپ انہیں بھیجتے ہیں**۔

- **ڈیفالٹ طور پر مقامی:** سیشنز، میموری فائلز، کنفگ، اور ورک اسپیس گیٹ وے ہوسٹ پر رہتے ہیں
  (`~/.openclaw` + آپ کی ورک اسپیس ڈائریکٹری)۔
- **ضرورت کے تحت ریموٹ:** وہ پیغامات جو آپ ماڈل پرووائیڈرز (Anthropic/OpenAI/etc.) کو بھیجتے ہیں جاتے ہیں
  ان کے APIs پر، اور چیٹ پلیٹ فارمز (WhatsApp/Telegram/Slack/etc.) پیغام کا ڈیٹا اپنے
  سرورز پر محفوظ کرتے ہیں۔
- **آپ فُٹ پرنٹ کنٹرول کرتے ہیں:** لوکل ماڈلز استعمال کرنے سے پرامپٹس آپ کی مشین پر رہتے ہیں، لیکن چینل
  ٹریفک پھر بھی چینل کے سرورز سے گزرتی ہے۔

متعلقہ: [Agent workspace](/concepts/agent-workspace)، [Memory](/concepts/memory)۔

### OpenClaw اپنا ڈیٹا کہاں محفوظ کرتا ہے

سب کچھ `$OPENCLAW_STATE_DIR` کے تحت رہتا ہے (ڈیفالٹ: `~/.openclaw`):

| پاتھ                                                            | Purpose                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `$OPENCLAW_STATE_DIR/openclaw.json`                             | مین کنفیگ (JSON5)                                                        |
| `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | لیگیسی OAuth امپورٹ (پہلے استعمال پر auth پروفائلز میں کاپی کیا جاتا ہے) |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth پروفائلز (OAuth + API keys)                                         |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | رن ٹائم auth کیشے (خودکار طور پر منیج ہوتی ہے)                           |
| `$OPENCLAW_STATE_DIR/credentials/`                              | پرووائیڈر اسٹیٹ (مثلاً `whatsapp/<accountId>/creds.json`)                |
| `$OPENCLAW_STATE_DIR/agents/`                                   | فی ایجنٹ اسٹیٹ (agentDir + sessions)                                     |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | گفتگو کی ہسٹری اور اسٹیٹ (فی ایجنٹ)                                      |
| `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | سیشن میٹا ڈیٹا (فی ایجنٹ)                                                |

لیگیسی سنگل ایجنٹ پاتھ: `~/.openclaw/agent/*` (`openclaw doctor` کے ذریعے مائیگریٹ کیا جاتا ہے)۔

آپ کی **ورک اسپیس** (AGENTS.md، میموری فائلز، اسکلز، وغیرہ) `~/.openclaw` سے الگ ہے اور `agents.defaults.workspace` کے ذریعے کنفیگر ہوتی ہے (ڈیفالٹ: `~/.openclaw/workspace`)۔

### AGENTSmd، SOULmd، USERmd، MEMORYmd کہاں ہونے چاہئیں

یہ فائلیں **ایجنٹ ورک اسپیس** میں ہوتی ہیں، `~/.openclaw` میں نہیں۔

- **ورک اسپیس (فی ایجنٹ)**: `AGENTS.md`، `SOUL.md`، `IDENTITY.md`، `USER.md`,
  `MEMORY.md` (یا `memory.md`)، `memory/YYYY-MM-DD.md`، اختیاری `HEARTBEAT.md`۔
- **اسٹیٹ ڈائریکٹری (`~/.openclaw`)**: کنفگ، اسناد، auth پروفائلز، سیشنز، لاگز،
  اور مشترکہ اسکلز (`~/.openclaw/skills`)۔

ڈیفالٹ ورک اسپیس `~/.openclaw/workspace` ہے، جسے یہاں سے کنفیگر کیا جا سکتا ہے:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

اگر بوٹ ری اسٹارٹ کے بعد "بھول" جائے، تو تصدیق کریں کہ گیٹ وے ہر لانچ پر ایک ہی
ورک اسپیس استعمال کر رہا ہے (اور یاد رکھیں: ریموٹ موڈ **گیٹ وے ہوسٹ کی** ورک اسپیس استعمال کرتا ہے، آپ کے مقامی لیپ ٹاپ کی نہیں)۔

ٹِپ: اگر آپ پائیدار رویہ یا ترجیح چاہتے ہیں، تو بوٹ سے کہیں کہ وہ اسے **AGENTS.md یا MEMORY.md میں لکھ دے** بجائے چیٹ ہسٹری پر انحصار کرنے کے۔

[Agent workspace](/concepts/agent-workspace) اور [Memory](/concepts/memory) دیکھیں۔

### بیک اپ کی تجویز کردہ حکمتِ عملی کیا ہے

اپنی **ایجنٹ ورک اسپیس** کو ایک **پرائیویٹ** git ریپو میں رکھیں اور اسے کسی پرائیویٹ جگہ پر بیک اپ کریں (مثلاً GitHub پرائیویٹ)۔ یہ میموری + AGENTS/SOUL/USER
فائلز کو محفوظ کرتا ہے، اور بعد میں اسسٹنٹ کے "ذہن" کو بحال کرنے دیتا ہے۔

`~/.openclaw` کے تحت کسی بھی چیز کو commit **نہ کریں** (اسناد، سیشنز، ٹوکنز)۔
اگر آپ کو مکمل بحالی درکار ہو، تو ورک اسپیس اور اسٹیٹ ڈائریکٹری دونوں کا الگ الگ بیک اپ لیں
(اوپر مائیگریشن والے سوال کو دیکھیں)۔

دستاویزات: [Agent workspace](/concepts/agent-workspace)۔

### میں OpenClaw کو مکمل طور پر کیسے ان انسٹال کروں

مخصوص گائیڈ دیکھیں: [Uninstall](/install/uninstall)۔

### کیا ایجنٹس ورک اسپیس کے باہر کام کر سکتے ہیں

ہاں. The workspace is the **default cwd** and memory anchor, not a hard sandbox.
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

### Im in remote mode where is the session store

Session state is owned by the **gateway host**. If you're in remote mode, the session store you care about is on the remote machine, not your local laptop. See [Session management](/concepts/session).

## Config basics

### What format is the config Where is it

OpenClaw reads an optional **JSON5** config from `$OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`):

```
$OPENCLAW_CONFIG_PATH
```

If the file is missing, it uses safe-ish defaults (including a default workspace of `~/.openclaw/workspace`).

### I set gatewaybind lan or tailnet and now nothing listens the UI says unauthorized

Non-loopback binds **require auth**. Configure `gateway.auth.mode` + `gateway.auth.token` (or use `OPENCLAW_GATEWAY_TOKEN`).

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

Notes:

- `gateway.remote.token` is for **remote CLI calls** only; it does not enable local gateway auth.
- The Control UI authenticates via `connect.params.auth.token` (stored in app/UI settings). Avoid putting tokens in URLs.

### Why do I need a token on localhost now

The wizard generates a gateway token by default (even on loopback) so **local WS clients must authenticate**. This blocks other local processes from calling the Gateway. Paste the token into the Control UI settings (or your client config) to connect.

If you **really** want open loopback, remove `gateway.auth` from your config. Doctor can generate a token for you any time: `openclaw doctor --generate-gateway-token`.

### Do I have to restart after changing config

The Gateway watches the config and supports hot-reload:

- `gateway.reload.mode: "hybrid"` (default): hot-apply safe changes, restart for critical ones
- `hot`, `restart`, `off` are also supported

### How do I enable web search and web fetch

`web_fetch` works without an API key. `web_search` requires a Brave Search API
key. **Recommended:** run `openclaw configure --section web` to store it in
`tools.web.search.apiKey`. Environment alternative: set `BRAVE_API_KEY` for the
Gateway process.

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

نوٹس:

- If you use allowlists, add `web_search`/`web_fetch` or `group:web`.
- `web_fetch` بطورِ طے شدہ فعال ہے (جب تک صراحتاً غیرفعال نہ کیا جائے)۔
- Daemons read env vars from `~/.openclaw/.env` (or the service environment).

Docs: [Web tools](/tools/web).

### How do I run a central Gateway with specialized workers across devices

The common pattern is **one Gateway** (e.g. Raspberry Pi) plus **nodes** and **agents**:

- **Gateway (central):** owns channels (Signal/WhatsApp), routing, and sessions.
- **Nodes (devices):** Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).
- **Agents (workers):** separate brains/workspaces for special roles (e.g. "Hetzner ops", "Personal data").
- **Sub-agents:** spawn background work from a main agent when you want parallelism.
- **TUI:** connect to the Gateway and switch agents/sessions.

Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

### Can the OpenClaw browser run headless

ہاں. It's a config option:

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

ڈیفالٹ `false` ہے (ہیڈفل)۔ Headless is more likely to trigger anti-bot checks on some sites. See [Browser](/tools/browser).

Headless uses the **same Chromium engine** and works for most automation (forms, clicks, scraping, logins). The main differences:

- No visible browser window (use screenshots if you need visuals).
- Some sites are stricter about automation in headless mode (CAPTCHAs, anti-bot).
  For example, X/Twitter often blocks headless sessions.

### How do I use Brave for browser control

Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway.
See the full config examples in [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).

## Remote gateways and nodes

### How do commands propagate between Telegram the gateway and nodes

Telegram messages are handled by the **gateway**. The gateway runs the agent and
only then calls nodes over the **Gateway WebSocket** when a node tool is needed:

Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

Nodes don't see inbound provider traffic; they only receive node RPC calls.

### How can my agent access my computer if the Gateway is hosted remotely

Short answer: **pair your computer as a node**. The Gateway runs elsewhere, but it can
call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

Typical setup:

1. Run the Gateway on the always-on host (VPS/home server).
2. Put the Gateway host + your computer on the same tailnet.
3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet)
   so it can register as a node.
5. Approve the node on the Gateway:

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

No separate TCP bridge is required; nodes connect over the Gateway WebSocket.

Security reminder: pairing a macOS node allows `system.run` on that machine. Only
pair devices you trust, and review [Security](/gateway/security).

Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

### Tailscale is connected but I get no replies What now

Check the basics:

- Gateway is running: `openclaw gateway status`
- Gateway health: `openclaw status`
- Channel health: `openclaw channels status`

Then verify auth and routing:

- If you use Tailscale Serve, make sure `gateway.auth.allowTailscale` is set correctly.
- If you connect via SSH tunnel, confirm the local tunnel is up and points at the right port.
- Confirm your allowlists (DM or group) include your account.

Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

### Can two OpenClaw instances talk to each other local VPS

ہاں. There is no built-in "bot-to-bot" bridge, but you can wire it up in a few
reliable ways:

**Simplest:** use a normal chat channel both bots can access (Telegram/Slack/WhatsApp).
Have Bot A send a message to Bot B, then let Bot B reply as usual.

**CLI bridge (generic):** run a script that calls the other Gateway with
`openclaw agent --message ... --deliver`, targeting a chat where the other bot
listens. If one bot is on a remote VPS, point your CLI at that remote Gateway
via SSH/Tailscale (see [Remote access](/gateway/remote)).

1. مثال پیٹرن (ایسی مشین سے چلائیں جو ہدف گیٹ وے تک رسائی رکھتی ہو):

```bash
openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
```

3. ٹِپ: ایک گارڈریل شامل کریں تاکہ دونوں بوٹس لامتناہی لوپ میں نہ پھنسیں (صرف-ذکر، چینل allowlists، یا "بوٹ پیغامات کا جواب نہ دیں" کا اصول)۔

4. دستاویزات: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

### 5. کیا مجھے متعدد ایجنٹس کے لیے الگ الگ VPS درکار ہیں

نہیں. 6. ایک ہی گیٹ وے متعدد ایجنٹس کی میزبانی کر سکتا ہے، ہر ایک کے لیے الگ ورک اسپیس، ماڈل ڈیفالٹس، اور روٹنگ کے ساتھ۔ 7. یہی عام سیٹ اپ ہے اور یہ ہر ایجنٹ کے لیے ایک VPS چلانے کے مقابلے میں کہیں سستا اور سادہ ہے۔

8. الگ VPSes صرف تب استعمال کریں جب آپ کو سخت آئسولیشن (سیکیورٹی حدود) یا بہت مختلف کنفیگریشنز درکار ہوں جنہیں آپ شیئر نہیں کرنا چاہتے۔ 9. بصورت دیگر، ایک ہی گیٹ وے رکھیں اور متعدد ایجنٹس یا سب-ایجنٹس استعمال کریں۔

### 10. کیا VPS سے SSH کرنے کے بجائے اپنے ذاتی لیپ ٹاپ پر نوڈ استعمال کرنے کا کوئی فائدہ ہے

11. جی ہاں — نوڈز ریموٹ گیٹ وے سے آپ کے لیپ ٹاپ تک پہنچنے کا فرسٹ-کلاس طریقہ ہیں، اور وہ صرف شیل رسائی سے کہیں زیادہ صلاحیتیں فراہم کرتے ہیں۔ 12. گیٹ وے macOS/Linux پر چلتا ہے (Windows بذریعہ WSL2) اور ہلکا پھلکا ہے (ایک چھوٹا VPS یا Raspberry Pi-کلاس باکس کافی ہے؛ 4 GB RAM وافر ہے)، اس لیے عام سیٹ اپ ایک ہمیشہ آن ہوسٹ کے ساتھ آپ کا لیپ ٹاپ بطور نوڈ ہوتا ہے۔

- 13. **ان باؤنڈ SSH کی ضرورت نہیں۔** نوڈز گیٹ وے WebSocket سے آؤٹ باؤنڈ کنیکٹ کرتے ہیں اور ڈیوائس پیئرنگ استعمال کرتے ہیں۔
- 14. **زیادہ محفوظ ایکزیکیوشن کنٹرولز۔** `system.run` اس لیپ ٹاپ پر نوڈ allowlists/منظوریوں کے ذریعے محدود ہوتا ہے۔
- 15. **مزید ڈیوائس ٹولز۔** نوڈز `system.run` کے علاوہ `canvas`, `camera`, اور `screen` بھی فراہم کرتے ہیں۔
- 16. **لوکل براؤزر آٹومیشن۔** گیٹ وے کو VPS پر رکھیں، لیکن Chrome کو لوکل چلائیں اور Chrome ایکسٹینشن + لیپ ٹاپ پر نوڈ ہوسٹ کے ذریعے کنٹرول ریلے کریں۔

17. عارضی شیل رسائی کے لیے SSH ٹھیک ہے، لیکن جاری ایجنٹ ورک فلو اور ڈیوائس آٹومیشن کے لیے نوڈز زیادہ سادہ ہیں۔

18. دستاویزات: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Chrome extension](/tools/chrome-extension).

### 19. کیا مجھے دوسرے لیپ ٹاپ پر انسٹال کرنا چاہیے یا صرف ایک نوڈ شامل کرنا چاہیے

20. اگر آپ کو دوسرے لیپ ٹاپ پر صرف **لوکل ٹولز** (screen/camera/exec) درکار ہیں تو اسے بطور **نوڈ** شامل کریں۔ 21. اس سے ایک ہی گیٹ وے برقرار رہتا ہے اور ڈپلیکیٹ کنفیگریشن سے بچاؤ ہوتا ہے۔ 22. لوکل نوڈ ٹولز فی الحال صرف macOS تک محدود ہیں، لیکن ہم انہیں دیگر OSes تک بڑھانے کا منصوبہ رکھتے ہیں۔

23. دوسرا گیٹ وے صرف تب انسٹال کریں جب آپ کو **سخت آئسولیشن** یا دو مکمل طور پر الگ بوٹس درکار ہوں۔

24. دستاویزات: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

### 25. کیا نوڈز گیٹ وے سروس چلاتے ہیں

نہیں. 26. فی ہوسٹ صرف **ایک گیٹ وے** چلنا چاہیے، جب تک کہ آپ جان بوجھ کر آئسولیٹڈ پروفائلز نہ چلا رہے ہوں (دیکھیں [Multiple gateways](/gateway/multiple-gateways))۔ 27. نوڈز پیری فیرلز ہوتے ہیں جو گیٹ وے سے کنیکٹ ہوتے ہیں (iOS/Android نوڈز، یا macOS میں مینو بار ایپ کا "node mode")۔ 28. ہیڈ لیس نوڈ ہوسٹس اور CLI کنٹرول کے لیے، دیکھیں [Node host CLI](/cli/node).

29. `gateway`, `discovery`, اور `canvasHost` میں تبدیلیوں کے لیے مکمل ری اسٹارٹ درکار ہوتا ہے۔

### 30. کیا کنفیگ لاگو کرنے کے لیے کوئی API RPC طریقہ موجود ہے

ہاں. 31. `config.apply` مکمل کنفیگ کی توثیق + تحریر کرتا ہے اور آپریشن کے حصے کے طور پر گیٹ وے کو ری اسٹارٹ کرتا ہے۔

### configapply نے میری کنفیگ مٹا دی — میں اسے کیسے بحال کروں اور اس سے کیسے بچوں

33. `config.apply` **پوری کنفیگ** کو بدل دیتا ہے۔ 34. اگر آپ جزوی آبجیکٹ بھیجیں تو باقی سب کچھ ہٹا دیا جاتا ہے۔

35. بحالی:

- بیک اپ سے بحال کریں (git یا کاپی کی گئی `~/.openclaw/openclaw.json`)۔
- 37. اگر آپ کے پاس بیک اپ نہیں ہے تو `openclaw doctor` دوبارہ چلائیں اور چینلز/ماڈلز دوبارہ کنفیگر کریں۔
- 38. اگر یہ غیر متوقع تھا تو بگ رپورٹ فائل کریں اور اپنی آخری معلوم کنفیگ یا کوئی بھی بیک اپ شامل کریں۔
- 39. ایک لوکل کوڈنگ ایجنٹ اکثر لاگز یا ہسٹری سے ایک قابلِ عمل کنفیگ دوبارہ تشکیل دے سکتا ہے۔

40. اس سے بچاؤ:

- 41. چھوٹی تبدیلیوں کے لیے `openclaw config set` استعمال کریں۔
- 42. انٹرایکٹو ترامیم کے لیے `openclaw configure` استعمال کریں۔

43. دستاویزات: [Config](/cli/config), [Configure](/cli/configure), [Doctor](/gateway/doctor).

### 44. پہلی انسٹالیشن کے لیے کم از کم معقول کنفیگ کیا ہے

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

45. یہ آپ کا ورک اسپیس سیٹ کرتا ہے اور یہ محدود کرتا ہے کہ کون بوٹ کو ٹرگر کر سکتا ہے۔

### 46. میں VPS پر Tailscale کیسے سیٹ اپ کروں اور اپنے Mac سے کنیکٹ کیسے کروں

47. کم سے کم مراحل:

1. 48. **VPS پر انسٹال + لاگ اِن کریں**

   ```bash
   49. curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

2. 50. **اپنے Mac پر انسٹال + لاگ اِن کریں**
   - 2. **MagicDNS فعال کریں (تجویز کردہ)**

3. 3. Tailscale ایڈمن کنسول میں MagicDNS فعال کریں تاکہ VPS کا ایک مستحکم نام ہو۔
   - 4. **tailnet hostname استعمال کریں**

4. 5. SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
   - 6. Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`
   - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

8) اس سے گیٹ وے loopback سے بندھا رہتا ہے اور Tailscale کے ذریعے HTTPS ایکسپوز ہوتا ہے۔

```bash
openclaw gateway --tailscale serve
```

9. دیکھیں [Tailscale](/gateway/tailscale). 10. میں Mac نوڈ کو ریموٹ Gateway Tailscale Serve سے کیسے جوڑوں

### 11. Serve **Gateway Control UI + WS** کو ایکسپوز کرتا ہے۔

12. نوڈز اسی Gateway WS اینڈپوائنٹ کے ذریعے کنیکٹ ہوتے ہیں۔ 13. تجویز کردہ سیٹ اپ:

14. **یقینی بنائیں کہ VPS اور Mac ایک ہی tailnet پر ہیں**۔

1. 15. **macOS ایپ کو Remote موڈ میں استعمال کریں** (SSH ٹارگٹ tailnet hostname ہو سکتا ہے)۔
2. 16. ایپ Gateway پورٹ کو ٹنل کرے گی اور ایک نوڈ کے طور پر کنیکٹ ہوگی۔
   17. **گیٹ وے پر نوڈ کی منظوری دیں**:
3. 18. ڈاکس: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

   ```bash
   openclaw nodes pending
   openclaw nodes approve <requestId>
   ```

19) Env vars اور .env لوڈنگ

## 20. OpenClaw ماحول کی متغیرات کیسے لوڈ کرتا ہے

### 21. OpenClaw والدین پروسیس (shell، launchd/systemd، CI، وغیرہ) سے env vars پڑھتا ہے

22. اور اضافی طور پر لوڈ کرتا ہے: 23. موجودہ ورکنگ ڈائریکٹری سے `.env`

- موجودہ ورکنگ ڈائریکٹری سے `.env`
- 25. دونوں `.env` فائلیں موجودہ env vars کو اووررائیڈ نہیں کرتیں۔

26. آپ کنفیگ میں inline env vars بھی ڈیفائن کر سکتے ہیں (صرف اس صورت میں لاگو ہوں گی جب پروسیس env میں موجود نہ ہوں):

27. {
    env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: { GROQ_API_KEY: "gsk-..." },
    },
    }

```json5
28. مکمل ترجیح اور سورسز کے لیے دیکھیں [/environment](/help/environment).
```

29. میں نے سروس کے ذریعے Gateway شروع کیا اور میرے env vars غائب ہو گئے۔ اب کیا کروں

### 30. دو عام حل:

31. گمشدہ کیز `~/.openclaw/.env` میں رکھیں تاکہ سروس کے آپ کے shell env کو inherit نہ کرنے کی صورت میں بھی وہ لوڈ ہو جائیں۔

1. 32. shell امپورٹ فعال کریں (اختیاری سہولت):
2. 33. یہ آپ کا لاگ اِن shell چلاتا ہے اور صرف وہی متوقع کیز امپورٹ کرتا ہے جو غائب ہوں (کبھی اووررائیڈ نہیں کرتا)۔

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

34. Env var متبادلات:
    `OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`. 35. میں نے COPILOTGITHUBTOKEN سیٹ کیا ہے لیکن models status میں Shell env off کیوں دکھا رہا ہے

### 36. `openclaw models status` رپورٹ کرتا ہے کہ آیا **shell env import** فعال ہے یا نہیں۔

37. "Shell env: off"
    اس کا مطلب یہ **نہیں** کہ آپ کے env vars موجود نہیں — اس کا مطلب صرف یہ ہے کہ OpenClaw
    خودکار طور پر آپ کا لاگ اِن shell لوڈ نہیں کرے گا۔ 38. اگر Gateway سروس کے طور پر چل رہا ہو (launchd/systemd)، تو یہ آپ کے shell
    environment کو inherit نہیں کرے گا۔

39. ان میں سے کوئی ایک کر کے مسئلہ حل کریں: 40. ٹوکن `~/.openclaw/.env` میں رکھیں:

1. 41. COPILOT_GITHUB_TOKEN=...

   ```
   42. یا shell امپورٹ فعال کریں (`env.shellEnv.enabled: true`)۔
   ```

2. 43. یا اسے اپنی کنفیگ کے `env` بلاک میں شامل کریں (صرف اس صورت میں لاگو ہوگا جب غائب ہو)۔

3. 44. پھر گیٹ وے کو ری اسٹارٹ کریں اور دوبارہ چیک کریں:

45) Copilot ٹوکنز `COPILOT_GITHUB_TOKEN` سے پڑھے جاتے ہیں (نیز `GH_TOKEN` / `GITHUB_TOKEN`)۔

```bash
openclaw models status
```

46. دیکھیں [/concepts/model-providers](/concepts/model-providers) اور [/environment](/help/environment).
47. سیشنز اور متعدد چیٹس

## 48. میں ایک نیا مکالمہ کیسے شروع کروں

### میں ایک نئی گفتگو کیسے شروع کروں

50. دیکھیں [Session management](/concepts/session). See [Session management](/concepts/session).

### Do sessions reset automatically if I never send new

ہاں. Sessions expire after `session.idleMinutes` (default **60**). The **next**
message starts a fresh session id for that chat key. This does not delete
transcripts - it just starts a new session.

```json5
{
  session: {
    idleMinutes: 240,
  },
}
```

### Is there a way to make a team of OpenClaw instances one CEO and many agents

Yes, via **multi-agent routing** and **sub-agents**. You can create one coordinator
agent and several worker agents with their own workspaces and models.

That said, this is best seen as a **fun experiment**. It is token heavy and often
less efficient than using one bot with separate sessions. The typical model we
envision is one bot you talk to, with different sessions for parallel work. That
bot can also spawn sub-agents when needed.

Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

### Why did context get truncated midtask How do I prevent it

Session context is limited by the model window. Long chats, large tool outputs, or many
files can trigger compaction or truncation.

What helps:

- Ask the bot to summarize the current state and write it to a file.
- Use `/compact` before long tasks, and `/new` when switching topics.
- Keep important context in the workspace and ask the bot to read it back.
- طویل یا متوازی کام کے لیے سب-ایجنٹس استعمال کریں تاکہ مین چیٹ چھوٹی رہے۔
- Pick a model with a larger context window if this happens often.

### میں OpenClaw کو مکمل طور پر کیسے ری سیٹ کروں لیکن انسٹال رکھا جائے

Use the reset command:

```bash
openclaw reset
```

Non-interactive full reset:

```bash
openclaw reset --scope full --yes --non-interactive
```

Then re-run onboarding:

```bash
openclaw onboard --install-daemon
```

Notes:

- The onboarding wizard also offers **Reset** if it sees an existing config. See [Wizard](/start/wizard).
- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (defaults are `~/.openclaw-<profile>`).
- Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

### Im getting context too large errors how do I reset or compact

ان میں سے ایک استعمال کریں:

- **Compact** (keeps the conversation but summarizes older turns):

  ```
  /compact
  ```

  or `/compact <instructions>` to guide the summary.

- **Reset** (fresh session ID for the same chat key):

  ```
  /new
  /reset
  ```

If it keeps happening:

- Enable or tune **session pruning** (`agents.defaults.contextPruning`) to trim old tool output.
- Use a model with a larger context window.

Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

### Why am I seeing LLM request rejected messagesNcontentXtooluseinput Field required

This is a provider validation error: the model emitted a `tool_use` block without the required
`input`. It usually means the session history is stale or corrupted (often after long threads
or a tool/schema change).

Fix: start a fresh session with `/new` (standalone message).

### Why am I getting heartbeat messages every 30 minutes

Heartbeats run every **30m** by default. Tune or disable them:

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

If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.
اگر فائل غائب ہو تو ہارٹ بیٹ پھر بھی چلتا ہے اور ماڈل فیصلہ کرتا ہے کہ کیا کرنا ہے۔

Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

### Do I need to add a bot account to a WhatsApp group

نہیں. OpenClaw runs on **your own account**, so if you're in the group, OpenClaw can see it.
By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

If you want only **you** to be able to trigger group replies:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

### How do I get the JID of a WhatsApp group

Option 1 (fastest): tail logs and send a test message in the group:

```bash
openclaw logs --follow --json
```

Look for `chatId` (or `from`) ending in `@g.us`, like:
`1234567890-1234567890@g.us`.

Option 2 (if already configured/allowlisted): list groups from config:

```bash
openclaw directory groups list --channel whatsapp
```

Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

### Why doesnt OpenClaw reply in a group

Two common causes:

- Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
- You configured `channels.whatsapp.groups` without `"*"` and the group isn't allowlisted.

See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### Do groupsthreads share context with DMs

Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

### How many workspaces and agents can I create

No hard limits. Dozens (even hundreds) are fine, but watch for:

- **Disk growth:** sessions + transcripts live under `~/.openclaw/agents/<agentId>/sessions/`.
- **Token cost:** more agents means more concurrent model usage.
- **Ops overhead:** per-agent auth profiles, workspaces, and channel routing.

مشورے:

- Keep one **active** workspace per agent (`agents.defaults.workspace`).
- Prune old sessions (delete JSONL or store entries) if disk grows.
- Use `openclaw doctor` to spot stray workspaces and profile mismatches.

### Can I run multiple bots or chats at the same time Slack and how should I set that up

ہاں. Use **Multi-Agent Routing** to run multiple isolated agents and route inbound messages by
channel/account/peer. Slack is supported as a channel and can be bound to specific agents.

Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can
still block automation. For the most reliable browser control, use the Chrome extension relay
on the machine that runs the browser (and keep the Gateway anywhere).

Best-practice setup:

- Always-on Gateway host (VPS/Mac mini).
- One agent per role (bindings).
- Slack channel(s) bound to those agents.
- Local browser via extension relay (or a node) when needed.

Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
[Browser](/tools/browser), [Chrome extension](/tools/chrome-extension), [Nodes](/nodes).

## Models: defaults, selection, aliases, switching

### What is the default model

OpenClaw's default model is whatever you set as:

```
agents.defaults.model.primary
```

Models are referenced as `provider/model` (example: `anthropic/claude-opus-4-6`). If you omit the provider, OpenClaw currently assumes `anthropic` as a temporary deprecation fallback - but you should still **explicitly** set `provider/model`.

### What model do you recommend

**تجویز کردہ ڈیفالٹ:** `anthropic/claude-opus-4-6`.
**اچھا متبادل:** `anthropic/claude-sonnet-4-5`.
**قابلِ اعتماد (کم شخصیت):** `openai/gpt-5.2` - اوپس جتنا ہی اچھا، بس شخصیت کچھ کم ہے۔
**کم بجٹ:** `zai/glm-4.7`.

MiniMax M2.1 کی اپنی دستاویزات ہیں: [MiniMax](/providers/minimax) اور
[Local models](/gateway/local-models).

عمومی اصول: زیادہ اہم کام کے لیے **وہ بہترین ماڈل استعمال کریں جو آپ برداشت کر سکتے ہوں**، اور روزمرہ چیٹ یا خلاصوں کے لیے سستا ماڈل۔ آپ ہر ایجنٹ کے لیے ماڈلز روٹ کر سکتے ہیں اور طویل کاموں کو متوازی کرنے کے لیے سب ایجنٹس استعمال کر سکتے ہیں (ہر سب ایجنٹ ٹوکنز استعمال کرتا ہے)۔ [Models](/concepts/models) اور
[Sub-agents](/tools/subagents) دیکھیں۔

سخت انتباہ: کمزور یا حد سے زیادہ کوانٹائزڈ ماڈلز پرامپٹ انجیکشن اور غیر محفوظ رویّے کے لیے زیادہ حساس ہوتے ہیں۔ [Security](/gateway/security) دیکھیں۔

مزید سیاق و سباق: [Models](/concepts/models).

### کیا میں خود ہوسٹڈ ماڈلز llamacpp vLLM Ollama استعمال کر سکتا ہوں

ہاں. اگر آپ کا لوکل سرور OpenAI-مطابقت رکھنے والا API فراہم کرتا ہے تو آپ اس کی طرف ایک
کسٹم پرووائیڈر پوائنٹ کر سکتے ہیں۔ Ollama براہِ راست سپورٹ کیا جاتا ہے اور یہ سب سے آسان راستہ ہے۔

سیکیورٹی نوٹ: چھوٹے یا بہت زیادہ کوانٹائزڈ ماڈلز پرامپٹ انجیکشن کے لیے زیادہ حساس ہوتے ہیں۔ ہم کسی بھی ایسے بوٹ کے لیے جو ٹولز استعمال کر سکتا ہو **بڑے ماڈلز** کی سختی سے سفارش کرتے ہیں۔
اگر آپ پھر بھی چھوٹے ماڈلز چاہتے ہیں تو سینڈباکسنگ اور سخت ٹول الاولِسٹ فعال کریں۔

Docs: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
[Model providers](/concepts/model-providers), [Security](/gateway/security),
[Sandboxing](/gateway/sandboxing).

### میں کنفیگ صاف کیے بغیر ماڈلز کیسے تبدیل کروں

**ماڈل کمانڈز** استعمال کریں یا صرف **model** فیلڈز میں ترمیم کریں۔ مکمل کنفیگ ری پلیس کرنے سے گریز کریں۔

محفوظ آپشنز:

- `/model` چیٹ میں (تیز، فی سیشن)
- `openclaw models set ...` (صرف ماڈل کنفیگ اپ ڈیٹ کرتا ہے)
- `openclaw configure --section model` (انٹرایکٹو)
- `~/.openclaw/openclaw.json` میں `agents.defaults.model` ایڈٹ کریں

`config.apply` کو جزوی آبجیکٹ کے ساتھ استعمال کرنے سے بچیں، الا یہ کہ آپ پورا کنفیگ بدلنا چاہتے ہوں۔
اگر کنفیگ اوور رائٹ ہو گیا ہو تو بیک اپ سے بحال کریں یا مرمت کے لیے `openclaw doctor` دوبارہ چلائیں۔

Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

### OpenClaw، Flawd، اور Krill ماڈلز کے لیے کیا استعمال کرتے ہیں

- **OpenClaw + Flawd:** Anthropic Opus (`anthropic/claude-opus-4-6`) - [Anthropic](/providers/anthropic) دیکھیں۔
- **Krill:** MiniMax M2.1 (`minimax/MiniMax-M2.1`) - [MiniMax](/providers/minimax) دیکھیں۔

### میں ری اسٹارٹ کیے بغیر فوراً ماڈلز کیسے تبدیل کروں

`/model` کمانڈ کو ایک الگ پیغام کے طور پر استعمال کریں:

```
/model sonnet
/model haiku
/model opus
/model gpt
/model gpt-mini
/model gemini
/model gemini-flash
```

آپ دستیاب ماڈلز کو `/model`, `/model list`, یا `/model status` کے ذریعے دیکھ سکتے ہیں۔

`/model` (اور `/model list`) ایک مختصر، نمبر شدہ پِکر دکھاتا ہے۔ نمبر کے ذریعے منتخب کریں:

```
/model 3
```

آپ پرووائیڈر کے لیے ایک مخصوص auth پروفائل بھی مجبوراً منتخب کر سکتے ہیں (فی سیشن):

```
/model opus@anthropic:default
/model opus@anthropic:work
```

ٹِپ: `/model status` دکھاتا ہے کہ کون سا ایجنٹ فعال ہے، کون سی `auth-profiles.json` فائل استعمال ہو رہی ہے، اور اگلا کون سا auth پروفائل آزمایا جائے گا۔
یہ کنفیگر شدہ پرووائیڈر اینڈپوائنٹ (`baseUrl`) اور API موڈ (`api`) بھی دکھاتا ہے جب دستیاب ہوں۔

**میں profile کے ساتھ سیٹ کیے گئے پروفائل کو کیسے ان پن کروں**

`@profile` سفکس کے **بغیر** `/model` دوبارہ چلائیں:

```
/model anthropic/claude-opus-4-6
```

اگر آپ ڈیفالٹ پر واپس جانا چاہتے ہیں تو `/model` سے اسے منتخب کریں (یا `/model <default provider/model>` بھیجیں)۔
یہ تصدیق کرنے کے لیے `/model status` استعمال کریں کہ کون سا auth پروفائل فعال ہے۔

### کیا میں روزمرہ کاموں کے لیے GPT 5.2 اور کوڈنگ کے لیے Codex 5.3 استعمال کر سکتا ہوں

ہاں. ایک کو ڈیفالٹ سیٹ کریں اور ضرورت کے مطابق سوئچ کریں:

- 1. **فوری سوئچ (فی سیشن):** روزمرہ کاموں کے لیے `/model gpt-5.2`، اور کوڈنگ کے لیے `/model gpt-5.3-codex`۔
- 2. **ڈیفالٹ + سوئچ:** `agents.defaults.model.primary` کو `openai/gpt-5.2` پر سیٹ کریں، پھر کوڈنگ کے وقت `openai-codex/gpt-5.3-codex` پر سوئچ کریں (یا اس کے برعکس)۔
- 3. **سب ایجنٹس:** کوڈنگ کے کاموں کو مختلف ڈیفالٹ ماڈل والے سب ایجنٹس کی طرف روٹ کریں۔

4. دیکھیں [Models](/concepts/models) اور [Slash commands](/tools/slash-commands)۔

### 5. مجھے "Model is not allowed" کیوں نظر آتا ہے اور پھر کوئی جواب کیوں نہیں آتا

6. اگر `agents.defaults.models` سیٹ ہو، تو یہ `/model` اور کسی بھی سیشن اوور رائیڈز کے لیے **allowlist** بن جاتا ہے۔ 7. اس فہرست میں نہ ہونے والا ماڈل منتخب کرنے پر یہ نتیجہ ملتا ہے:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

8. یہ خرابی عام جواب کے **بجائے** واپس آتی ہے۔ 9. حل: ماڈل کو `agents.defaults.models` میں شامل کریں، allowlist ہٹا دیں، یا `/model list` میں سے کوئی ماڈل منتخب کریں۔

### 10. مجھے "Unknown model minimaxMiniMaxM21" کیوں نظر آتا ہے

11. اس کا مطلب ہے کہ **provider کنفیگر نہیں ہے** (MiniMax پرووائیڈر کی کوئی کنفیگریشن یا auth پروفائل نہیں ملا)، اس لیے ماڈل resolve نہیں ہو سکتا۔ 12. اس ڈیٹیکشن کے لیے ایک فکس **2026.1.12** میں ہے (تحریر کے وقت unreleased)۔

13. فکس چیک لسٹ:

1. **2026.1.12** پر اپ گریڈ کریں (یا سورس `main` سے چلائیں)، پھر گیٹ وے ری اسٹارٹ کریں۔
2. 15. یقینی بنائیں کہ MiniMax کنفیگر ہے (وزارڈ یا JSON)، یا env/auth پروفائلز میں MiniMax API key موجود ہو تاکہ پرووائیڈر انجیکٹ ہو سکے۔
3. 16. عین ماڈل ID استعمال کریں (case-sensitive): `minimax/MiniMax-M2.1` یا `minimax/MiniMax-M2.1-lightning`۔
4. Run:

   ```bash
   openclaw models list
   ```

   17. اور فہرست میں سے منتخب کریں (یا چیٹ میں `/model list`)۔

18) دیکھیں [MiniMax](/providers/minimax) اور [Models](/concepts/models)۔

### 19. کیا میں MiniMax کو ڈیفالٹ اور پیچیدہ کاموں کے لیے OpenAI استعمال کر سکتا ہوں

ہاں. 20. **MiniMax کو ڈیفالٹ** کے طور پر استعمال کریں اور ضرورت پڑنے پر **فی سیشن** ماڈلز سوئچ کریں۔
21. Fallbacks **غلطیوں** کے لیے ہوتے ہیں، "مشکل کاموں" کے لیے نہیں، اس لیے `/model` یا علیحدہ ایجنٹ استعمال کریں۔

22. **آپشن A: فی سیشن سوئچ**

```json5
23. {
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

پھر:

```
/model gpt
```

25. **آپشن B: علیحدہ ایجنٹس**

- 26. ایجنٹ A ڈیفالٹ: MiniMax
- 27. ایجنٹ B ڈیفالٹ: OpenAI
- 28. ایجنٹ کے ذریعے روٹ کریں یا سوئچ کرنے کے لیے `/agent` استعمال کریں

29. دستاویزات: [Models](/concepts/models)، [Multi-Agent Routing](/concepts/multi-agent)، [MiniMax](/providers/minimax)، [OpenAI](/providers/openai)۔

### 30. کیا opus sonnet gpt بلٹ اِن شارٹ کٹس ہیں

ہاں. 31. OpenClaw کچھ ڈیفالٹ شارٹ ہینڈز کے ساتھ آتا ہے (صرف تب لاگو ہوتے ہیں جب ماڈل `agents.defaults.models` میں موجود ہو):

- 32. `opus` → `anthropic/claude-opus-4-6`
- 33. `sonnet` → `anthropic/claude-sonnet-4-5`
- 34. `gpt` → `openai/gpt-5.2`
- 35. `gpt-mini` → `openai/gpt-5-mini`
- 36. `gemini` → `google/gemini-3-pro-preview`
- 37. `gemini-flash` → `google/gemini-3-flash-preview`

38. اگر آپ اسی نام سے اپنا alias سیٹ کریں تو آپ کی ویلیو کو ترجیح دی جائے گی۔

### 39. میں ماڈل شارٹ کٹس/aliases کو کیسے define یا override کروں

40. Aliases `agents.defaults.models.<modelId>` سے آتے ہیں41. `.alias`۔ مثال:

```json5
42. {
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

43. پھر `/model sonnet` (یا جب سپورٹ ہو تو `/<alias>`) اسی ماڈل ID پر resolve ہو جاتا ہے۔

### 44. میں OpenRouter یا ZAI جیسے دوسرے پرووائیڈرز سے ماڈلز کیسے شامل کروں

OpenRouter (فی ٹوکن ادائیگی؛ متعدد ماڈلز):

```json5
1. {
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
      models: { "openrouter/anthropic/claude-sonnet-4-5": {} },
    },
  },
  env: { OPENROUTER_API_KEY: "sk-or-..." },
}
```

2. Z.AI (GLM ماڈلز):

```json5
48. {
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
  env: { ZAI_API_KEY: "..." },
}
```

49. اگر آپ کسی پرووائیڈر/ماڈل کا حوالہ دیں لیکن مطلوبہ پرووائیڈر کی کلید موجود نہ ہو، تو رن ٹائم auth ایرر آئے گا (مثلاً `No API key found for provider "zai"`)۔

50. **نیا ایجنٹ شامل کرنے کے بعد پرووائیڈر کے لیے کوئی API key نہیں ملی**

1. اس کا عام طور پر مطلب یہ ہوتا ہے کہ **نئے ایجنٹ** کے پاس خالی auth اسٹور ہے۔ 2. Auth ہر ایجنٹ کے لیے الگ ہوتی ہے اور
   محفوظ کی جاتی ہے:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

حل کے اختیارات:

- 3. `openclaw agents add <id>` چلائیں اور وزارڈ کے دوران auth کنفیگر کریں۔
- 4. یا مرکزی ایجنٹ کے `agentDir` سے `auth-profiles.json` کو نئے ایجنٹ کے `agentDir` میں کاپی کریں۔

5. ایجنٹس کے درمیان `agentDir` دوبارہ استعمال **نہ** کریں؛ اس سے auth/سیشن ٹکراؤ پیدا ہوتے ہیں۔

## 6. ماڈل فیل اوور اور "All models failed"

### 7. فیل اوور کیسے کام کرتا ہے

8. فیل اوور دو مراحل میں ہوتا ہے:

1. 9. ایک ہی فراہم کنندہ کے اندر **Auth پروفائل روٹیشن**۔
2. **ماڈل فال بیک** `agents.defaults.model.fallbacks` میں اگلے ماڈل تک۔

10) ناکام ہونے والے پروفائلز پر کول ڈاؤن لاگو ہوتے ہیں (exponential backoff)، تاکہ OpenClaw اس وقت بھی جواب دیتا رہے جب کوئی فراہم کنندہ ریٹ لمٹڈ ہو یا عارضی طور پر ناکام ہو۔

### 11. اس خرابی کا کیا مطلب ہے

```
12. پروفائل "anthropic:default" کے لیے کوئی اسناد نہیں ملیں
```

13. اس کا مطلب یہ ہے کہ سسٹم نے auth پروفائل ID `anthropic:default` استعمال کرنے کی کوشش کی، لیکن متوقع auth اسٹور میں اس کی اسناد نہیں مل سکیں۔

### 14. پروفائل anthropicdefault کے لیے "No credentials found" کی درستگی کی چیک لسٹ

- 15. **تصدیق کریں کہ auth پروفائلز کہاں موجود ہیں** (نئے بمقابلہ لیگیسی راستے)
  - 16. موجودہ: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
  - 17. لیگیسی: `~/.openclaw/agent/*` (`openclaw doctor` کے ذریعے مائیگریٹ کیا جاتا ہے)
- 18. **تصدیق کریں کہ آپ کا env var گیٹ وے کے ذریعے لوڈ ہو رہا ہے**
  - 19. اگر آپ نے اپنے شیل میں `ANTHROPIC_API_KEY` سیٹ کیا ہے لیکن گیٹ وے systemd/launchd کے ذریعے چلا رہے ہیں، تو ممکن ہے وہ اسے وراثت میں نہ لے۔ 20. اسے `~/.openclaw/.env` میں رکھیں یا `env.shellEnv` فعال کریں۔
- 21. **یقینی بنائیں کہ آپ درست ایجنٹ ایڈٹ کر رہے ہیں**
  - 22. ملٹی ایجنٹ سیٹ اپس میں متعدد `auth-profiles.json` فائلیں ہو سکتی ہیں۔
- 23. **ماڈل/auth اسٹیٹس کی سینیٹی چیک کریں**
  - 24. کنفیگر کیے گئے ماڈلز اور فراہم کنندگان کی تصدیق شدہ حیثیت دیکھنے کے لیے `openclaw models status` استعمال کریں۔

25. پروفائل anthropic کے لیے "No credentials found" کی درستگی کی چیک لسٹ

26. اس کا مطلب ہے کہ رَن ایک Anthropic auth پروفائل پر پن کیا گیا ہے، لیکن گیٹ وے اسے اپنے auth اسٹور میں نہیں ڈھونڈ پا رہا۔

- 27. **setup-token استعمال کریں**
  - 28. `claude setup-token` چلائیں، پھر اسے `openclaw models auth setup-token --provider anthropic` کے ساتھ پیسٹ کریں۔
  - 29. اگر ٹوکن کسی اور مشین پر بنایا گیا تھا، تو `openclaw models auth paste-token --provider anthropic` استعمال کریں۔

- 30. **اگر آپ اس کے بجائے API key استعمال کرنا چاہتے ہیں**
  - 31. **گیٹ وے ہوسٹ** پر `ANTHROPIC_API_KEY` کو `~/.openclaw/.env` میں رکھیں۔
  - 32. کسی بھی پن شدہ آرڈر کو صاف کریں جو گمشدہ پروفائل کو مجبور کرتا ہو:

    ```bash
    33. openclaw models auth order clear --provider anthropic
    ```

- 34. **تصدیق کریں کہ آپ گیٹ وے ہوسٹ پر کمانڈز چلا رہے ہیں**
  - 35. ریموٹ موڈ میں، auth پروفائلز گیٹ وے مشین پر ہوتے ہیں، آپ کے لیپ ٹاپ پر نہیں۔

### 36. اس نے Google Gemini کو بھی کیوں آزمایا اور ناکام ہوا

37. اگر آپ کی ماڈل کنفیگ میں Google Gemini بطور فالبیک شامل ہے (یا آپ نے Gemini شارٹ ہینڈ پر سوئچ کیا ہے)، تو OpenClaw ماڈل فالبیک کے دوران اسے آزمائے گا۔ 38. اگر آپ نے Google کی اسناد کنفیگر نہیں کیں، تو آپ کو `No API key found for provider "google"` نظر آئے گا۔

39. حل: یا تو Google auth فراہم کریں، یا `agents.defaults.model.fallbacks` / aliases میں Google ماڈلز کو ہٹا دیں/ان سے گریز کریں تاکہ فالبیک وہاں روٹ نہ ہو۔

40. **LLM request rejected message thinking signature required google antigravity**

41. وجہ: سیشن ہسٹری میں **بغیر دستخط کے thinking بلاکس** موجود ہیں (اکثر منسوخ/جزوی اسٹریم سے)۔ 42. Google Antigravity کو thinking بلاکس کے لیے دستخط درکار ہوتے ہیں۔

43. حل: OpenClaw اب Google Antigravity Claude کے لیے بغیر دستخط والے thinking بلاکس کو ہٹا دیتا ہے۔ 44. اگر پھر بھی ظاہر ہو، تو **نیا سیشن** شروع کریں یا اس ایجنٹ کے لیے `/thinking off` سیٹ کریں۔

## 45. Auth پروفائلز: وہ کیا ہیں اور انہیں کیسے منظم کیا جائے

46. متعلقہ: [/concepts/oauth](/concepts/oauth) (OAuth فلو، ٹوکن اسٹوریج، ملٹی اکاؤنٹ پیٹرنز)

### 47. Auth پروفائل کیا ہے

48. Auth پروفائل ایک نامزد اسناد ریکارڈ ہوتا ہے (OAuth یا API key) جو کسی فراہم کنندہ سے منسلک ہوتا ہے۔ 49. پروفائلز یہاں موجود ہوتے ہیں:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

### 50. عام پروفائل IDs کیا ہوتے ہیں

OpenClaw uses provider-prefixed IDs like:

- `anthropic:default` (common when no email identity exists)
- `anthropic:<email>` for OAuth identities
- custom IDs you choose (e.g. `anthropic:work`)

### Can I control which auth profile is tried first

ہاں. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

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

3. کسی مخصوص ایجنٹ کو ہدف بنانے کے لیے:

```bash
openclaw models auth order set --provider anthropic --agent main anthropic:default
```

### OAuth vs API key whats the difference

OpenClaw supports both:

- **OAuth** often leverages subscription access (where applicable).
- 4. **API keys** میں pay-per-token بلنگ استعمال ہوتی ہے۔

The wizard explicitly supports Anthropic setup-token and OpenAI Codex OAuth and can store API keys for you.

## Gateway: ports, "already running", and remote mode

### What port does the Gateway use

`gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).

ترجیحی ترتیب:

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

### 5. میں OpenClaw کو ریموٹ موڈ میں کیسے چلاؤں جہاں کلائنٹ کہیں اور موجود Gateway سے کنیکٹ ہو

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

Notes:

- `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).
- The macOS app watches the config file and switches modes live when these values change.

### The Control UI says unauthorized or keeps reconnecting What now

Your gateway is running with auth enabled (`gateway.auth.*`), but the UI is not sending the matching token/password.

Facts (from code):

- The Control UI stores the token in browser localStorage key `openclaw.control.settings.v1`.

Fix:

- Fastest: `openclaw dashboard` (prints + copies the dashboard URL, tries to open; shows SSH hint if headless).
- If you don't have a token yet: `openclaw doctor --generate-gateway-token`.
- 1. اگر ریموٹ ہو تو پہلے ٹنل بنائیں: `ssh -N -L 18789:127.0.0.1:18789 user@host` پھر `http://127.0.0.1:18789/` کھولیں۔
- 2. گیٹ وے ہوسٹ پر `gateway.auth.token` (یا `OPENCLAW_GATEWAY_TOKEN`) سیٹ کریں۔
- 3. کنٹرول UI کی سیٹنگز میں وہی ٹوکن پیسٹ کریں۔
- 4. اب بھی مسئلہ ہے؟ 5. `openclaw status --all` چلائیں اور [Troubleshooting](/gateway/troubleshooting) پر عمل کریں۔ 6. تصدیق کی تفصیلات کے لیے [Dashboard](/web/dashboard) دیکھیں۔

### 7. میں نے gatewaybind tailnet سیٹ کیا ہے لیکن یہ بائنڈ نہیں ہو رہا، کچھ بھی سن نہیں رہا۔

8. `tailnet` بائنڈ آپ کے نیٹ ورک انٹرفیسز سے ایک Tailscale IP منتخب کرتا ہے (100.64.0.0/10)۔ 9. اگر مشین Tailscale پر نہیں ہے (یا انٹرفیس ڈاؤن ہے)، تو بائنڈ کرنے کے لیے کچھ نہیں۔

Fix:

- 10. اس ہوسٹ پر Tailscale شروع کریں (تاکہ اس کے پاس 100.x ایڈریس ہو)، یا
- 11. `gateway.bind: "loopback"` / `"lan"` پر سوئچ کریں۔

12. نوٹ: `tailnet` واضح (explicit) ہے۔ 13. `auto` لوپ بیک کو ترجیح دیتا ہے؛ جب آپ صرف tailnet پر بائنڈ چاہتے ہوں تو `gateway.bind: "tailnet"` استعمال کریں۔

### 14. کیا میں ایک ہی ہوسٹ پر متعدد Gateways چلا سکتا ہوں؟

15. عموماً نہیں — ایک Gateway متعدد میسجنگ چینلز اور ایجنٹس چلا سکتا ہے۔ 16. متعدد Gateways صرف تب استعمال کریں جب آپ کو ریڈنڈنسی (مثلاً ریسکیو بوٹ) یا سخت آئسولیشن درکار ہو۔

17. ہاں، لیکن آپ کو آئسولیٹ کرنا ہوگا:

- 18. `OPENCLAW_CONFIG_PATH` (ہر انسٹینس کے لیے کنفگ)
- 19. `OPENCLAW_STATE_DIR` (ہر انسٹینس کے لیے اسٹیٹ)
- 20. `agents.defaults.workspace` (ورک اسپیس آئسولیشن)
- 21. `gateway.port` (یونیک پورٹس)

22. فوری سیٹ اپ (تجویز کردہ):

- 23. ہر انسٹینس کے لیے `openclaw --profile <name> …` استعمال کریں (خودکار طور پر `~/.openclaw-<name>` بناتا ہے)۔
- 24. ہر پروفائل کنفگ میں منفرد `gateway.port` سیٹ کریں (یا دستی رنز کے لیے `--port` پاس کریں)۔
- 25. ہر پروفائل کے لیے سروس انسٹال کریں: `openclaw --profile <name> gateway install`۔

26. پروفائلز سروس ناموں کے ساتھ لاحقہ بھی لگاتے ہیں (`bot.molt.<profile>`27. `; legacy `com.openclaw.\*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)\`)۔
27. مکمل گائیڈ: [Multiple gateways](/gateway/multiple-gateways)۔

### 29. invalid handshake code 1008 کا کیا مطلب ہے؟

30. گیٹ وے ایک **WebSocket server** ہے، اور یہ توقع کرتا ہے کہ بالکل پہلا پیغام be a `connect` frame.

31. اگر اسے اس کے علاوہ کچھ بھی ملے، تو یہ کنکشن کو

- **code 1008** (policy violation) کے ساتھ بند کر دیتا ہے۔
- 6. آپ نے غلط پورٹ یا راستہ (path) استعمال کیا ہے۔
- 33. آپ نے WS کلائنٹ کے بجائے براؤزر میں **HTTP** URL کھولا (`http://...`)۔

34. آپ نے غلط پورٹ یا پاتھ استعمال کیا۔

1. 35. کسی پروکسی یا ٹنل نے auth ہیڈرز ہٹا دیے یا غیر Gateway ریکویسٹ بھیج دی۔
2. 36. فوری حل:
3. 37. WS URL استعمال کریں: `ws://<host>:18789` (یا اگر HTTPS ہو تو `wss://...`)۔

38) WS پورٹ کو عام براؤزر ٹیب میں نہ کھولیں۔

```
39. اگر auth آن ہے تو `connect` فریم میں ٹوکن/پاس ورڈ شامل کریں۔
```

7. پروٹوکول کی تفصیلات: [Gateway protocol](/gateway/protocol).

## 8. لاگنگ اور ڈیبگنگ

### 42. پروٹوکول کی تفصیلات: [Gateway protocol](/gateway/protocol)۔

43. لاگنگ اور ڈیبگنگ

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

44. لاگز کہاں ہیں؟ 45. فائل لاگز (structured): 46. آپ `logging.file` کے ذریعے ایک مستحکم پاتھ سیٹ کر سکتے ہیں۔

47. فائل لاگ لیول `logging.level` کے ذریعے کنٹرول ہوتا ہے۔

```bash
openclaw logs --follow
```

48. کنسول کی verbosity `--verbose` اور `logging.consoleLevel` سے کنٹرول ہوتی ہے۔

- macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` and `gateway.err.log` (default: `~/.openclaw/logs/...`; profiles use `~/.openclaw-<profile>/logs/...`)
- Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
- Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

See [Troubleshooting](/gateway/troubleshooting#log-locations) for more.

### How do I startstoprestart the Gateway service

Use the gateway helpers:

```bash
openclaw gateway status
openclaw gateway restart
```

If you run the gateway manually, `openclaw gateway --force` can reclaim the port. See [Gateway](/gateway).

### I closed my terminal on Windows how do I restart OpenClaw

There are **two Windows install modes**:

**1) WSL2 (recommended):** the Gateway runs inside Linux.

Open PowerShell, enter WSL, then restart:

```powershell
wsl
openclaw gateway status
openclaw gateway restart
```

If you never installed the service, start it in the foreground:

```bash
openclaw gateway run
```

**2) Native Windows (not recommended):** the Gateway runs directly in Windows.

Open PowerShell and run:

```powershell
openclaw gateway status
openclaw gateway restart
```

If you run it manually (no service), use:

```powershell
openclaw gateway run
```

Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

### The Gateway is up but replies never arrive What should I check

Start with a quick health sweep:

```bash
openclaw status
openclaw models status
openclaw channels status
openclaw logs --follow
```

Common causes:

- Model auth not loaded on the **gateway host** (check `models status`).
- Channel pairing/allowlist blocking replies (check channel config + logs).
- WebChat/Dashboard is open without the right token.

If you are remote, confirm the tunnel/Tailscale connection is up and that the
Gateway WebSocket is reachable.

Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

### Disconnected from gateway no reason what now

This usually means the UI lost the WebSocket connection. Check:

1. Is the Gateway running? `openclaw gateway status`
2. Is the Gateway healthy? `openclaw status`
3. Does the UI have the right token? `openclaw dashboard`
4. If remote, is the tunnel/Tailscale link up?

Then tail logs:

```bash
openclaw logs --follow
```

Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

### Telegram setMyCommands fails with network errors What should I check

Start with logs and channel status:

```bash
openclaw channels status
openclaw channels logs --channel telegram
```

If you are on a VPS or behind a proxy, confirm outbound HTTPS is allowed and DNS works.
If the Gateway is remote, make sure you are looking at logs on the Gateway host.

Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

### TUI shows no output What should I check

First confirm the Gateway is reachable and the agent can run:

```bash
openclaw status
openclaw models status
openclaw logs --follow
```

In the TUI, use `/status` to see the current state. If you expect replies in a chat
channel, make sure delivery is enabled (`/deliver on`).

Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

### 9. میں Gateway کو مکمل طور پر کیسے بند کر کے دوبارہ شروع کروں

اگر آپ نے سروس انسٹال کی ہے:

```bash
openclaw gateway stop
```

openclaw gateway start
یہ **نگرانی شدہ سروس** کو روکتا/شروع کرتا ہے (macOS پر launchd، Linux پر systemd)۔

جب گیٹ وے بیک گراؤنڈ میں بطور ڈیمون چل رہا ہو تو یہ استعمال کریں۔

```bash
openclaw gateway run
```

اگر آپ فرنٹ گراؤنڈ میں چلا رہے ہیں تو Ctrl-C سے روکیں، پھر:

### دستاویزات: [Gateway service runbook](/gateway).

- ELI5: openclaw gateway restart بمقابلہ openclaw gateway
- `openclaw gateway restart`: **بیک گراؤنڈ سروس** (launchd/systemd) کو دوبارہ شروع کرتا ہے۔

`openclaw gateway`: اس ٹرمینل سیشن کے لیے گیٹ وے کو **فرنٹ گراؤنڈ میں** چلاتا ہے۔ 10. جب آپ کو ایک وقتی، foreground رن چاہیے ہو تو `openclaw gateway` استعمال کریں۔

### `openclaw gateway` اس وقت استعمال کریں جب&#xA;آپ ایک وقتی، فرنٹ گراؤنڈ رن چاہتے ہوں۔

11. مزید کنسول تفصیل حاصل کرنے کے لیے Gateway کو `--verbose` کے ساتھ شروع کریں۔ 12. پھر چینل آتھنٹیکیشن، ماڈل روٹنگ، اور RPC ایررز کے لیے لاگ فائل کا جائزہ لیں۔

## پھر چینل آتھنٹیکیشن، ماڈل روٹنگ، اور RPC خرابیوں کے لیے لاگ فائل دیکھیں۔

### میڈیا اور منسلکات

میری اسکل نے ایک imagePDF بنایا لیکن کچھ بھی نہیں بھیجا گیا ایجنٹ سے بھیجے جانے والے آؤٹ باؤنڈ منسلکات میں ایک `MEDIA:<path-or-url>` لائن (الگ لائن پر) شامل ہونی چاہیے۔

[OpenClaw assistant setup](/start/openclaw) اور [Agent send](/tools/agent-send) دیکھیں۔

```bash
13. openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
```

openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png

- 14. ہدف چینل آؤٹ باؤنڈ میڈیا کو سپورٹ کرتا ہو اور allowlists کے ذریعے بلاک نہ ہو۔
- 15. فائل پرووائیڈر کی سائز لمٹس کے اندر ہو (تصاویر کو زیادہ سے زیادہ 2048px تک ری سائز کیا جاتا ہے)۔

فائل فراہم کنندہ کی سائز حد کے اندر ہو (تصاویر کو زیادہ سے زیادہ 2048px تک ری سائز کیا جاتا ہے)۔

## [Images](/nodes/images) دیکھیں۔

### سیکیورٹی اور رسائی کنٹرول

کیا OpenClaw کو اِن باؤنڈ DMs کے لیے ایکسپوز کرنا محفوظ ہے 16. ڈیفالٹس کو رسک کم کرنے کے لیے ڈیزائن کیا گیا ہے:

- ڈیفالٹس خطرے کو کم کرنے کے لیے ڈیزائن کیے گئے ہیں:
  - DM-قابل چینلز پر ڈیفالٹ رویہ **pairing** ہے:
  - 17. اس کے ساتھ منظوری دیں: `openclaw pairing approve <channel> <code>`
  - منظوری دیں: `openclaw pairing approve <channel> <code>`
- زیرِ التواء درخواستیں **ہر چینل پر 3** تک محدود ہیں؛ اگر کوڈ نہیں آیا تو `openclaw pairing list <channel>` چیک کریں۔

DMs کو عوامی طور پر کھولنے کے لیے واضح opt-in درکار ہے (`dmPolicy: "open"` اور allowlist `"*"`)۔

### 18. کیا prompt injection صرف عوامی بوٹس کے لیے ہی تشویش کا باعث ہے

نہیں. کیا پرامپٹ انجیکشن صرف عوامی بوٹس کے لیے تشویش ہے
پرامپٹ انجیکشن **غیر معتبر مواد** کے بارے میں ہے، نہ کہ صرف یہ کہ کون بوٹ کو DM کر سکتا ہے۔ اگر آپ کا اسسٹنٹ بیرونی مواد پڑھتا ہے (ویب سرچ/فیچ، براؤزر صفحات، ای میلز،
دستاویزات، منسلکات، پیسٹ کیے گئے لاگز)، تو اس مواد میں ایسی ہدایات ہو سکتی ہیں جو
ماڈل کو ہائی جیک کرنے کی کوشش کریں۔

یہ اس صورت میں بھی ہو سکتا ہے جب **آپ ہی واحد بھیجنے والے** ہوں۔ سب سے بڑا خطرہ تب ہوتا ہے جب ٹولز فعال ہوں: ماڈل کو دھوکہ دے کر
سیاق و سباق خارج کروایا جا سکتا ہے یا آپ کی طرف سے ٹولز کال کروائے جا سکتے ہیں۔

- اثر کے دائرے کو کم کریں:
- غیر معتبر مواد کا خلاصہ بنانے کے لیے ریڈ اونلی یا ٹول-غیر فعال "reader" ایجنٹ استعمال کریں
- 19. sandboxing اور سخت tool allowlists

سینڈ باکسنگ اور سخت ٹول allowlists

### تفصیلات: [Security](/gateway/security).

کیا میرے بوٹ کے لیے الگ ای میل، GitHub اکاؤنٹ، یا فون نمبر ہونا چاہیے جی ہاں، زیادہ تر سیٹ اپس کے لیے۔ بوٹ کو الگ اکاؤنٹس اور فون نمبرز کے ساتھ الگ رکھنا
کسی خرابی کی صورت میں اثر کے دائرے کو کم کرتا ہے۔

اس سے اسناد (credentials) کو گھمانا
یا رسائی منسوخ کرنا بھی آسان ہو جاتا ہے بغیر آپ کے ذاتی اکاؤنٹس کو متاثر کیے۔ Give access only to the tools and accounts you actually need, and expand
later if required.

Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

### Can I give it autonomy over my text messages and is that safe

We do **not** recommend full autonomy over your personal messages. The safest pattern is:

- Keep DMs in **pairing mode** or a tight allowlist.
- Use a **separate number or account** if you want it to message on your behalf.
- Let it draft, then **approve before sending**.

If you want to experiment, do it on a dedicated account and keep it isolated. See
[Security](/gateway/security).

### Can I use cheaper models for personal assistant tasks

Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are
more susceptible to instruction hijacking, so avoid them for tool-enabled agents
or when reading untrusted content. If you must use a smaller model, lock down
tools and run inside a sandbox. See [Security](/gateway/security).

### I ran start in Telegram but didnt get a pairing code

Pairing codes are sent **only** when an unknown sender messages the bot and
`dmPolicy: "pairing"` is enabled. `/start` by itself doesn't generate a code.

Check pending requests:

```bash
openclaw pairing list telegram
```

If you want immediate access, allowlist your sender id or set `dmPolicy: "open"`
for that account.

### WhatsApp will it message my contacts How does pairing work

نہیں. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code and their message is **not processed**. 20. OpenClaw صرف انہی چیٹس کا جواب دیتا ہے جو اسے موصول ہوں یا وہ واضح sends جنہیں آپ خود ٹرگر کریں۔

Approve pairing with:

```bash
openclaw pairing approve whatsapp <code>
```

21. زیرِ التوا درخواستوں کی فہرست بنائیں:

```bash
openclaw pairing list whatsapp
```

Wizard phone number prompt: it's used to set your **allowlist/owner** so your own DMs are permitted. It's not used for auto-sending. If you run on your personal WhatsApp number, use that number and enable `channels.whatsapp.selfChatMode`.

## Chat commands, aborting tasks, and "it won't stop"

### How do I stop internal system messages from showing in chat

Most internal or tool messages only appear when **verbose** or **reasoning** is enabled
for that session.

Fix in the chat where you see it:

```
/verbose off
/reasoning off
```

22. اگر اب بھی زیادہ شور ہے تو Control UI میں سیشن سیٹنگز چیک کریں اور verbose کو **inherit** پر سیٹ کریں۔ Also confirm you are not using a bot profile with `verboseDefault` set
    to `on` in config.

Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security#reasoning--verbose-output-in-groups).

### How do I stopcancel a running task

Send any of these **as a standalone message** (no slash):

```
stop
abort
esc
wait
exit
interrupt
```

23. یہ abort triggers ہیں (slash commands نہیں)۔

For background processes (from the exec tool), you can ask the agent to run:

```
24. process action:kill sessionId:XXX
```

Slash commands overview: see [Slash commands](/tools/slash-commands).

Most commands must be sent as a **standalone** message that starts with `/`, but a few shortcuts (like `/status`) also work inline for allowlisted senders.

### How do I send a Discord message from Telegram Crosscontext messaging denied

OpenClaw blocks **cross-provider** messaging by default. 25. اگر کوئی tool call Telegram سے باؤنڈ ہے تو وہ Discord پر نہیں بھیجے گا جب تک آپ واضح طور پر اجازت نہ دیں۔

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

کنفیگ میں ترمیم کے بعد گیٹ وے کو دوبارہ شروع کریں۔ اگر آپ یہ صرف ایک واحد ایجنٹ کے لیے چاہتے ہیں، تو اسے `agents.list[].tools.message` کے تحت سیٹ کریں۔

### 26. ایسا کیوں لگتا ہے کہ بوٹ تیزی سے آنے والے پیغامات کو نظرانداز کر رہا ہے

کیو موڈ یہ کنٹرول کرتا ہے کہ نئے پیغامات ایک جاری رَن کے ساتھ کیسے تعامل کرتے ہیں۔ موڈ تبدیل کرنے کے لیے `/queue` استعمال کریں:

- `steer` - نئے پیغامات موجودہ ٹاسک کا رخ موڑ دیتے ہیں
- `followup` - پیغامات ایک وقت میں ایک چلتے ہیں
- `collect` - پیغامات کو بیچ کریں اور ایک بار جواب دیں (ڈیفالٹ)
- `steer-backlog` - ابھی رخ موڑیں، پھر بیک لاگ پراسیس کریں
- `interrupt` - موجودہ رَن ختم کریں اور ازسرِنو شروع کریں

آپ فالو اَپ موڈز کے لیے `debounce:2s cap:25 drop:summarize` جیسے آپشنز شامل کر سکتے ہیں۔

## اسکرین شاٹ/چیٹ لاگ میں موجود عین سوال کا جواب دیں

**سوال: "Anthropic کے لیے API key کے ساتھ ڈیفالٹ ماڈل کون سا ہے؟"**

**جواب:** OpenClaw میں، اسناد اور ماڈل کا انتخاب الگ ہوتے ہیں۔ `ANTHROPIC_API_KEY` سیٹ کرنا (یا auth profiles میں Anthropic API key محفوظ کرنا) توثیق کو فعال کرتا ہے، لیکن اصل ڈیفالٹ ماڈل وہی ہوتا ہے جو آپ `agents.defaults.model.primary` میں کنفیگر کرتے ہیں (مثال کے طور پر، `anthropic/claude-sonnet-4-5` یا `anthropic/claude-opus-4-6`)۔ اگر آپ کو `No credentials found for profile "anthropic:default"` نظر آئے، تو اس کا مطلب ہے کہ گیٹ وے کو چلنے والے ایجنٹ کے لیے متوقع `auth-profiles.json` میں Anthropic کی اسناد نہیں مل سکیں۔

---

27. اب بھی پھنسے ہوئے ہیں؟ [Discord](https://discord.com/invite/clawd) میں پوچھیں یا [GitHub discussion](https://github.com/openclaw/openclaw/discussions) کھولیں۔
