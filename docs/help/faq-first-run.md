---
summary: "FAQ: quick-start and first-run setup — install, onboard, auth, subscriptions, initial failures"
read_when:
  - New install, onboarding stuck, or first-run errors
  - Choosing auth and provider subscriptions
  - Cannot access docs.openclaw.ai, cannot open dashboard, install stuck
title: "FAQ: first-run setup"
sidebarTitle: "First-run FAQ"
---

Quick-start and first-run Q&A. For everyday operations, models, auth, sessions,
and troubleshooting see the main [FAQ](/help/faq).

This page is an index. The first-run Q&A is documented on two pages, one per
reader job. Open the page that matches your task.

| Page                                                                          | Read it when                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Quick start and first-run setup](/help/faq-first-run/quick-start)            | You are installing, onboarding, or hitting an error on the first run.              |
| [Providers, hardware, and hosting](/help/faq-first-run/providers-and-hosting) | You are picking provider auth or a model, or deciding what machine to run this on. |

## Where each section moved

Every anchor from the previous single-page version keeps its target here, so an
existing link such as
`/help/faq-first-run#why-am-i-seeing-http-429-ratelimiterror-from-anthropic`
still resolves. Each entry points at the page that now holds the content.

- <a id="quick-start-and-first-run-setup" />[Quick start and first-run setup](/help/faq-first-run/quick-start#quick-start-and-first-run-setup)
- <a id="i-am-stuck" />[I am stuck](/help/faq-first-run/quick-start#i-am-stuck)
- <a id="why-am-i-seeing-http-429-ratelimiterror-from-anthropic" />[Why am I seeing HTTP 429 rate_limit_error from Anthropic?](/help/faq-first-run/providers-and-hosting#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
- <a id="recommended-way-to-install-and-set-up-openclaw" />[Recommended way to install and set up OpenClaw](/help/faq-first-run/quick-start#recommended-way-to-install-and-set-up-openclaw)
- <a id="i-am-stuck-fastest-way-to-get-unstuck" />[I am stuck, fastest way to get unstuck](/help/faq-first-run/quick-start#i-am-stuck-fastest-way-to-get-unstuck)
- <a id="how-do-i-open-the-dashboard-after-onboarding" />[How do I open the dashboard after onboarding?](/help/faq-first-run/quick-start#how-do-i-open-the-dashboard-after-onboarding)
- <a id="how-do-i-authenticate-the-dashboard-on-localhost-vs-remote" />[How do I authenticate the dashboard on localhost vs remote?](/help/faq-first-run/quick-start#how-do-i-authenticate-the-dashboard-on-localhost-vs-remote)
- <a id="heartbeat-keeps-skipping-what-do-the-skip-reasons-mean" />[Heartbeat keeps skipping. What do the skip reasons mean?](/help/faq-first-run/quick-start#heartbeat-keeps-skipping-what-do-the-skip-reasons-mean)
- <a id="why-are-there-two-exec-approval-configs-for-chat-approvals" />[Why are there two exec approval configs for chat approvals?](/help/faq-first-run/quick-start#why-are-there-two-exec-approval-configs-for-chat-approvals)
- <a id="what-runtime-do-i-need" />[What runtime do I need?](/help/faq-first-run/quick-start#what-runtime-do-i-need)
- <a id="does-it-run-on-raspberry-pi" />[Does it run on Raspberry Pi?](/help/faq-first-run/quick-start#does-it-run-on-raspberry-pi)
- <a id="any-tips-for-raspberry-pi-installs" />[Any tips for Raspberry Pi installs?](/help/faq-first-run/quick-start#any-tips-for-raspberry-pi-installs)
- <a id="it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now" />[It is stuck on wake up my friend / onboarding will not hatch. What now?](/help/faq-first-run/quick-start#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
- <a id="can-i-migrate-my-setup-to-a-new-machine-without-redoing-onboarding" />[Can I migrate my setup to a new machine without redoing onboarding?](/help/faq-first-run/quick-start#can-i-migrate-my-setup-to-a-new-machine-without-redoing-onboarding)
- <a id="where-do-i-see-what-is-new-in-the-latest-version" />[Where do I see what is new in the latest version?](/help/faq-first-run/quick-start#where-do-i-see-what-is-new-in-the-latest-version)
- <a id="cannot-access-docs-openclaw-ai-ssl-error" />[Cannot access docs.openclaw.ai (SSL error)](/help/faq-first-run/quick-start#cannot-access-docs-openclaw-ai-ssl-error)
- <a id="difference-between-stable-and-beta" />[Difference between stable and beta](/help/faq-first-run/quick-start#difference-between-stable-and-beta)
- <a id="how-do-i-install-the-beta-version-and-what-is-the-difference-between-beta-and-dev" />[How do I install the beta version and what is the difference between beta and dev?](/help/faq-first-run/quick-start#how-do-i-install-the-beta-version-and-what-is-the-difference-between-beta-and-dev)
- <a id="how-do-i-try-the-latest-bits" />[How do I try the latest bits?](/help/faq-first-run/quick-start#how-do-i-try-the-latest-bits)
- <a id="how-long-does-install-and-onboarding-usually-take" />[How long does install and onboarding usually take?](/help/faq-first-run/quick-start#how-long-does-install-and-onboarding-usually-take)
- <a id="installer-stuck-how-do-i-get-more-feedback" />[Installer stuck? How do I get more feedback?](/help/faq-first-run/quick-start#installer-stuck-how-do-i-get-more-feedback)
- <a id="windows-install-says-git-not-found-or-openclaw-not-recognized" />[Windows install says git not found or openclaw not recognized](/help/faq-first-run/quick-start#windows-install-says-git-not-found-or-openclaw-not-recognized)
- <a id="windows-exec-output-shows-garbled-chinese-text-what-should-i-do" />[Windows exec output shows garbled Chinese text - what should I do?](/help/faq-first-run/quick-start#windows-exec-output-shows-garbled-chinese-text-what-should-i-do)
- <a id="the-docs-did-not-answer-my-question-how-do-i-get-a-better-answer" />[The docs did not answer my question - how do I get a better answer?](/help/faq-first-run/quick-start#the-docs-did-not-answer-my-question-how-do-i-get-a-better-answer)
- <a id="how-do-i-install-openclaw-on-linux" />[How do I install OpenClaw on Linux?](/help/faq-first-run/quick-start#how-do-i-install-openclaw-on-linux)
- <a id="how-do-i-install-openclaw-on-a-vps" />[How do I install OpenClaw on a VPS?](/help/faq-first-run/quick-start#how-do-i-install-openclaw-on-a-vps)
- <a id="where-are-the-cloud-vps-install-guides" />[Where are the cloud/VPS install guides?](/help/faq-first-run/quick-start#where-are-the-cloud-vps-install-guides)
- <a id="can-i-ask-openclaw-to-update-itself" />[Can I ask OpenClaw to update itself?](/help/faq-first-run/quick-start#can-i-ask-openclaw-to-update-itself)
- <a id="what-does-onboarding-actually-do" />[What does onboarding actually do?](/help/faq-first-run/quick-start#what-does-onboarding-actually-do)
- <a id="do-i-need-a-claude-or-openai-subscription-to-run-this" />[Do I need a Claude or OpenAI subscription to run this?](/help/faq-first-run/quick-start#do-i-need-a-claude-or-openai-subscription-to-run-this)
- <a id="can-i-use-claude-max-subscription-without-an-api-key" />[Can I use Claude Max subscription without an API key?](/help/faq-first-run/quick-start#can-i-use-claude-max-subscription-without-an-api-key)
- <a id="do-you-support-claude-subscription-auth-claude-pro-or-max" />[Do you support Claude subscription auth (Claude Pro or Max)?](/help/faq-first-run/quick-start#do-you-support-claude-subscription-auth-claude-pro-or-max)
- <a id="why-am-i-seeing-http-429-rate-limit-error-from-anthropic" />[Why am I seeing HTTP 429 rate_limit_error from Anthropic?](/help/faq-first-run/providers-and-hosting#why-am-i-seeing-http-429-rate-limit-error-from-anthropic)
- <a id="is-aws-bedrock-supported" />[Is AWS Bedrock supported?](/help/faq-first-run/providers-and-hosting#is-aws-bedrock-supported)
- <a id="how-does-codex-auth-work" />[How does Codex auth work?](/help/faq-first-run/providers-and-hosting#how-does-codex-auth-work)
- <a id="why-does-openclaw-still-mention-legacy-openai-codex-prefix" />[Why does OpenClaw still mention legacy OpenAI Codex prefix?](/help/faq-first-run/providers-and-hosting#why-does-openclaw-still-mention-legacy-openai-codex-prefix)
- <a id="why-can-codex-oauth-limits-differ-from-chatgpt-web" />[Why can Codex OAuth limits differ from ChatGPT web?](/help/faq-first-run/providers-and-hosting#why-can-codex-oauth-limits-differ-from-chatgpt-web)
- <a id="do-you-support-openai-subscription-auth-codex-oauth" />[Do you support OpenAI subscription auth (Codex OAuth)?](/help/faq-first-run/providers-and-hosting#do-you-support-openai-subscription-auth-codex-oauth)
- <a id="can-i-use-gemini-cli-or-antigravity-oauth" />[Can I use Gemini CLI or Antigravity OAuth?](/help/faq-first-run/providers-and-hosting#can-i-use-gemini-cli-or-antigravity-oauth)
- <a id="is-a-local-model-ok-for-casual-chats" />[Is a local model OK for casual chats?](/help/faq-first-run/providers-and-hosting#is-a-local-model-ok-for-casual-chats)
- <a id="how-do-i-keep-hosted-model-traffic-in-a-specific-region" />[How do I keep hosted model traffic in a specific region?](/help/faq-first-run/providers-and-hosting#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
- <a id="do-i-have-to-buy-a-mac-mini-to-install-this" />[Do I have to buy a Mac Mini to install this?](/help/faq-first-run/providers-and-hosting#do-i-have-to-buy-a-mac-mini-to-install-this)
- <a id="do-i-need-a-mac-mini-for-imessage-support" />[Do I need a Mac mini for iMessage support?](/help/faq-first-run/providers-and-hosting#do-i-need-a-mac-mini-for-imessage-support)
- <a id="if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro" />[If I buy a Mac mini to run OpenClaw, can I connect it to my MacBook Pro?](/help/faq-first-run/providers-and-hosting#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
- <a id="can-i-use-bun" />[Can I use Bun?](/help/faq-first-run/providers-and-hosting#can-i-use-bun)
- <a id="telegram-what-goes-in-allowfrom" />[Telegram: what goes in allowFrom?](/help/faq-first-run/providers-and-hosting#telegram-what-goes-in-allowfrom)
- <a id="can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances" />[Can multiple people use one WhatsApp number with different OpenClaw instances?](/help/faq-first-run/providers-and-hosting#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
- <a id="can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent" />[Can I run a "fast chat" agent and an "Opus for coding" agent?](/help/faq-first-run/providers-and-hosting#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
- <a id="does-homebrew-work-on-linux" />[Does Homebrew work on Linux?](/help/faq-first-run/providers-and-hosting#does-homebrew-work-on-linux)
- <a id="difference-between-the-hackable-git-install-and-npm-install" />[Difference between the hackable git install and npm install](/help/faq-first-run/providers-and-hosting#difference-between-the-hackable-git-install-and-npm-install)
- <a id="can-i-switch-between-npm-and-git-installs-later" />[Can I switch between npm and git installs later?](/help/faq-first-run/providers-and-hosting#can-i-switch-between-npm-and-git-installs-later)
- <a id="should-i-run-the-gateway-on-my-laptop-or-a-vps" />[Should I run the Gateway on my laptop or a VPS?](/help/faq-first-run/providers-and-hosting#should-i-run-the-gateway-on-my-laptop-or-a-vps)
- <a id="how-important-is-it-to-run-openclaw-on-a-dedicated-machine" />[How important is it to run OpenClaw on a dedicated machine?](/help/faq-first-run/providers-and-hosting#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
- <a id="what-are-the-minimum-vps-requirements-and-recommended-os" />[What are the minimum VPS requirements and recommended OS?](/help/faq-first-run/providers-and-hosting#what-are-the-minimum-vps-requirements-and-recommended-os)
- <a id="can-i-run-openclaw-in-a-vm-and-what-are-the-requirements" />[Can I run OpenClaw in a VM and what are the requirements?](/help/faq-first-run/providers-and-hosting#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)

## Related

- [FAQ](/help/faq) - the main FAQ (models, sessions, gateway, security, more)
- [Install overview](/install)
- [Getting started](/start/getting-started)
- [Troubleshooting](/help/troubleshooting)
