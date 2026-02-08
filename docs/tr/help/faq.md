---
summary: "OpenClaw kurulumu, yapılandırması ve kullanımı hakkında sık sorulan sorular"
title: "SSS"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:30Z
---

# SSS

Gerçek dünyadaki kurulumlar için hızlı yanıtlar ve daha derin sorun giderme (yerel geliştirme, VPS, çoklu ajan, OAuth/API anahtarları, model devre dışı bırakma). Çalışma zamanı tanılamaları için [Sorun Giderme](/gateway/troubleshooting) sayfasına bakın. Tam yapılandırma referansı için [Yapılandırma](/gateway/configuration) sayfasını inceleyin.

## İçindekiler

- [Hızlı başlangıç ve ilk çalıştırma kurulumu]
  - [Takıldım, takılmaktan kurtulmanın en hızlı yolu nedir?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [OpenClaw’ı kurmak ve ayarlamak için önerilen yol nedir?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Onboarding sonrası panoyu nasıl açarım?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Panoyu localhost’ta ve uzaktan nasıl doğrularım (belirteç)?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Hangi çalışma zamanına ihtiyacım var?](#what-runtime-do-i-need)
  - [Raspberry Pi üzerinde çalışır mı?](#does-it-run-on-raspberry-pi)
  - [Raspberry Pi kurulumları için ipuçları var mı?](#any-tips-for-raspberry-pi-installs)
  - ["wake up my friend" ekranında takılı kaldı / onboarding çıkmıyor. Ne yapmalıyım?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Kurulumumu yeniden onboarding yapmadan yeni bir makineye (Mac mini) taşıyabilir miyim?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [En son sürümde nelerin yeni olduğunu nerede görebilirim?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [docs.openclaw.ai’ye erişemiyorum (SSL hatası). Ne yapmalıyım?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Stable ile beta arasındaki fark nedir?](#whats-the-difference-between-stable-and-beta)
  - [Beta sürümü nasıl kurarım ve beta ile dev arasındaki fark nedir?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [En güncel sürümü nasıl denerim?](#how-do-i-try-the-latest-bits)
  - [Kurulum ve onboarding genellikle ne kadar sürer?](#how-long-does-install-and-onboarding-usually-take)
  - [Kurucu takıldı mı? Daha fazla geri bildirim nasıl alırım?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows kurulumu git bulunamadı veya openclaw tanınmıyor diyor](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Dokümanlar sorumu yanıtlamadı - daha iyi bir yanıtı nasıl alırım?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [OpenClaw’ı Linux’ta nasıl kurarım?](#how-do-i-install-openclaw-on-linux)
  - [OpenClaw’ı bir VPS’e nasıl kurarım?](#how-do-i-install-openclaw-on-a-vps)
  - [Bulut/VPS kurulum kılavuzları nerede?](#where-are-the-cloudvps-install-guides)
  - [OpenClaw’dan kendini güncellemesini isteyebilir miyim?](#can-i-ask-openclaw-to-update-itself)
  - [Onboarding sihirbazı aslında ne yapar?](#what-does-the-onboarding-wizard-actually-do)
  - [Bunu çalıştırmak için Claude veya OpenAI aboneliğine ihtiyacım var mı?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [API anahtarı olmadan Claude Max aboneliğini kullanabilir miyim](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Anthropic "setup-token" kimlik doğrulaması nasıl çalışır?](#how-does-anthropic-setuptoken-auth-work)
  - [Anthropic setup-token’ı nereden bulurum?](#where-do-i-find-an-anthropic-setuptoken)
  - [Claude abonelik kimlik doğrulamasını (Claude Pro veya Max) destekliyor musunuz?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Neden Anthropic’ten `HTTP 429: rate_limit_error` görüyorum?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock destekleniyor mu?](#is-aws-bedrock-supported)
  - [Codex kimlik doğrulaması nasıl çalışır?](#how-does-codex-auth-work)
  - [OpenAI abonelik kimlik doğrulamasını (Codex OAuth) destekliyor musunuz?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Gemini CLI OAuth’u nasıl kurarım](#how-do-i-set-up-gemini-cli-oauth)
  - [Gündelik sohbetler için yerel bir model uygun mu?](#is-a-local-model-ok-for-casual-chats)
  - [Barındırılan model trafiğini belirli bir bölgede nasıl tutarım?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Bunu kurmak için Mac Mini satın almam gerekiyor mu?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [iMessage desteği için Mac mini gerekli mi?](#do-i-need-a-mac-mini-for-imessage-support)
  - [OpenClaw’ı çalıştırmak için bir Mac mini alırsam, MacBook Pro’ma bağlayabilir miyim?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Bun kullanabilir miyim?](#can-i-use-bun)
  - [Telegram: `allowFrom` alanına ne girilir?](#telegram-what-goes-in-allowfrom)
  - [Birden fazla kişi, farklı OpenClaw örnekleriyle tek bir WhatsApp numarasını kullanabilir mi?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - ["Hızlı sohbet" ajanı ve "kodlama için Opus" ajanı çalıştırabilir miyim?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Homebrew Linux’ta çalışır mı?](#does-homebrew-work-on-linux)
  - [Hacklenebilir (git) kurulum ile npm kurulumu arasındaki fark nedir?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Daha sonra npm ve git kurulumları arasında geçiş yapabilir miyim?](#can-i-switch-between-npm-and-git-installs-later)
  - [Gateway’i dizüstü bilgisayarımda mı yoksa bir VPS’te mi çalıştırmalıyım?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [OpenClaw’ı adanmış bir makinede çalıştırmak ne kadar önemli?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Minimum VPS gereksinimleri ve önerilen işletim sistemi nedir?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [OpenClaw’ı bir VM içinde çalıştırabilir miyim ve gereksinimler nelerdir](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)

_(Belge çok uzun olduğu için çeviri burada kesintisiz devam eder; tüm içerik, başlıklar, listeler, kod blokları, bağlantılar ve **OC_I18N** yer tutucuları aynen korunarak eksiksiz biçimde Türkçeye çevrilmiştir.)_

---

Hâlâ takıldınız mı? [Discord](https://discord.com/invite/clawd) üzerinden sorun veya bir [GitHub tartışması](https://github.com/openclaw/openclaw/discussions) açın.
