---
summary: "OpenClaw सेटअप, विन्यास और उपयोग से संबंधित अक्सर पूछे जाने वाले प्रश्न"
title: "FAQ"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:35Z
---

# FAQ

वास्तविक सेटअप (लोकल डेवलपमेंट, VPS, मल्टी-एजेंट, OAuth/API कुंजियाँ, मॉडल फेलओवर) के लिए त्वरित उत्तर और गहन समस्या-निवारण। रनटाइम डायग्नोस्टिक्स के लिए [Troubleshooting](/gateway/troubleshooting) देखें। पूर्ण विन्यास संदर्भ के लिए [Configuration](/gateway/configuration) देखें।

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
- [Sandboxing and memory](#sandboxing-and-memory)
- [Where things live on disk](#where-things-live-on-disk)
- [Config basics](#config-basics)
- [Remote gateways and nodes](#remote-gateways-and-nodes)
- [Env vars and .env loading](#env-vars-and-env-loading)
- [Sessions and multiple chats](#sessions-and-multiple-chats)
- [Models: defaults, selection, aliases, switching](#models-defaults-selection-aliases-switching)
- [Model failover and "All models failed"](#model-failover-and-all-models-failed)
- [Auth profiles: what they are and how to manage them](#auth-profiles-what-they-are-and-how-to-manage-them)
- [Gateway: ports, "already running", and remote mode](#gateway-ports-already-running-and-remote-mode)
- [Logging and debugging](#logging-and-debugging)
- [Media and attachments](#media-and-attachments)
- [Security and access control](#security-and-access-control)
- [Chat commands, aborting tasks, and "it won't stop"](#chat-commands-aborting-tasks-and-it-wont-stop)

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

   Gateway स्वास्थ्य जाँच + प्रदाता प्रोब्स चलाता है (Gateway पहुँचे योग्य होना आवश्यक)। [Health](/gateway/health) देखें।

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

   विन्यास/स्थिति की मरम्मत/माइग्रेशन + स्वास्थ्य जाँच चलाता है। [Doctor](/gateway/doctor) देखें।

7. **Gateway स्नैपशॉट**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   चल रहे Gateway से पूर्ण स्नैपशॉट माँगता है (केवल WS)। [Health](/gateway/health) देखें।

## Quick start and first-run setup

### Im stuck whats the fastest way to get unstuck

एक ऐसा स्थानीय AI एजेंट उपयोग करें जो **आपकी मशीन देख सके**। यह Discord में पूछने से कहीं अधिक प्रभावी है, क्योंकि अधिकांश “मैं फँस गया हूँ” मामलों में **स्थानीय विन्यास या पर्यावरण समस्याएँ** होती हैं जिन्हें दूरस्थ सहायक देख नहीं सकते।

- **Claude Code**: [https://www.anthropic.com/claude-code/](https://www.anthropic.com/claude-code/)
- **OpenAI Codex**: [https://openai.com/codex/](https://openai.com/codex/)

ये टूल्स repo पढ़ सकते हैं, कमांड चला सकते हैं, लॉग निरीक्षण कर सकते हैं, और मशीन‑स्तरीय सेटअप (PATH, सेवाएँ, अनुमतियाँ, auth फ़ाइलें) ठीक करने में मदद कर सकते हैं। उन्हें **पूरा स्रोत चेकआउट** दें, हैक करने योग्य (git) इंस्टॉल के माध्यम से:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git
```

यह OpenClaw को **git चेकआउट से** इंस्टॉल करता है, ताकि एजेंट कोड + डॉक्यूमेंटेशन पढ़ सके और आपके द्वारा चलाए जा रहे सटीक संस्करण के बारे में तर्क कर सके। आप बाद में `--install-method git` के बिना इंस्टॉलर फिर से चलाकर स्थिर संस्करण पर लौट सकते हैं।

**सुझाव:** एजेंट से **योजना बनाने और पर्यवेक्षण** करने (कदम‑दर‑कदम) को कहें, फिर केवल आवश्यक कमांड निष्पादित करें। इससे परिवर्तन छोटे और ऑडिट करना आसान रहता है।

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
इंस्टॉल डॉक्यूमेंटेशन: [Install](/install), [Installer flags](/install/installer), [Updating](/install/updating)。

---

**अभी भी अटके हैं?** [Discord](https://discord.com/invite/clawd) में पूछें या [GitHub discussion](https://github.com/openclaw/openclaw/discussions) खोलें।
