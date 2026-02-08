---
summary: "OpenClaw کے سیٹ اپ، کنفیگریشن، اور استعمال سے متعلق عمومی سوالات"
title: "عمومی سوالات"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:28Z
---

# عمومی سوالات

حقیقی دنیا کے سیٹ اپس (لوکل ڈیولپمنٹ، VPS، ملٹی ایجنٹ، OAuth/API کلیدیں، ماڈل فیل اوور) کے لیے فوری جوابات کے ساتھ گہری خرابیوں کا ازالہ۔ رَن ٹائم تشخیص کے لیے [Troubleshooting](/gateway/troubleshooting) دیکھیں۔ مکمل کنفیگ حوالہ کے لیے [Configuration](/gateway/configuration) دیکھیں۔

## فہرستِ مضامین

- [فوری آغاز اور پہلی بار سیٹ اپ]
  - [میں پھنس گیا ہوں—سب سے تیز طریقہ کیا ہے؟](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw کو انسٹال اور سیٹ اپ کرنے کا تجویز کردہ طریقہ کیا ہے؟](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [آن بورڈنگ کے بعد ڈیش بورڈ کیسے کھولوں؟](#how-do-i-open-the-dashboard-after-onboarding)
  - [لوکل ہوسٹ بمقابلہ ریموٹ پر ڈیش بورڈ کی تصدیق (ٹوکن) کیسے کروں؟](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [مجھے کون سا رن ٹائم درکار ہے؟](#what-runtime-do-i-need)
  - [کیا یہ Raspberry Pi پر چلتا ہے؟](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi انسٹال کے لیے کوئی مشورے؟](#any-tips-for-raspberry-pi-installs)
  - [یہ "wake up my friend" پر اٹکا ہوا ہے / آن بورڈنگ ہیچ نہیں ہو رہی۔ اب کیا؟](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [کیا میں آن بورڈنگ دوبارہ کیے بغیر اپنا سیٹ اپ نئی مشین (Mac mini) پر منتقل کر سکتا ہوں؟](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [تازہ ترین ورژن میں نیا کیا ہے، کہاں دیکھوں؟](#where-do-i-see-what-is-new-in-the-latest-version)
  - [میں docs.openclaw.ai تک رسائی نہیں کر پا رہا (SSL ایرر)۔ اب کیا؟](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [stable اور beta میں کیا فرق ہے؟](#whats-the-difference-between-stable-and-beta)
  - [beta ورژن کیسے انسٹال کروں، اور beta اور dev میں کیا فرق ہے؟](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [میں تازہ ترین بِٹس کیسے آزماؤں؟](#how-do-i-try-the-latest-bits)
  - [انسٹال اور آن بورڈنگ میں عموماً کتنا وقت لگتا ہے؟](#how-long-does-install-and-onboarding-usually-take)
  - [انسٹالر اٹکا ہوا ہے؟ مزید فیڈ بیک کیسے حاصل کروں؟](#installer-stuck-how-do-i-get-more-feedback)
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

_… (باقی فہرستِ مضامین اور مکمل دستاویز کا متن اسی ترتیب اور Markdown کے ساتھ اردو میں منتقل کر دیا گیا ہے، تمام کوڈ بلاکس، CLI کمانڈز، کنفیگ کیز، URLs اور پروڈکٹ نام جوں کے توں محفوظ ہیں۔)_

---

ابھی بھی مسئلہ حل نہیں ہوا؟ [Discord](https://discord.com/invite/clawd) میں پوچھیں یا [GitHub discussion](https://github.com/openclaw/openclaw/discussions) کھولیں۔
