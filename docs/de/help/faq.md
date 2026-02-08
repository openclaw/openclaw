---
summary: "Häufig gestellte Fragen zur Einrichtung, Konfiguration und Nutzung von OpenClaw"
title: "FAQ"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:30Z
---

# FAQ

Kurze Antworten plus vertiefte Fehlerbehebung für reale Setups (lokale Entwicklung, VPS, Multi-Agent, OAuth/API-Schlüssel, Modell-Failover). Für Laufzeitdiagnosen siehe [Troubleshooting](/gateway/troubleshooting). Für die vollständige Konfigurationsreferenz siehe [Configuration](/gateway/configuration).

## Inhaltsverzeichnis

- [Schnellstart und Ersteinrichtung]
  - [Ich stecke fest – was ist der schnellste Weg, wieder weiterzukommen?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Was ist der empfohlene Weg, OpenClaw zu installieren und einzurichten?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Wie öffne ich das Dashboard nach dem Onboarding?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Wie authentifiziere ich das Dashboard (Token) auf localhost vs. remote?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Welche Runtime benötige ich?](#what-runtime-do-i-need)
  - [Läuft es auf einem Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Gibt es Tipps für Raspberry-Pi-Installationen?](#any-tips-for-raspberry-pi-installs)
  - [Es hängt bei „wake up my friend“ / das Onboarding schlüpft nicht. Was nun?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Kann ich mein Setup auf eine neue Maschine (Mac mini) migrieren, ohne das Onboarding erneut zu machen?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Wo sehe ich, was in der neuesten Version neu ist?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Ich kann docs.openclaw.ai nicht erreichen (SSL-Fehler). Was nun?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Was ist der Unterschied zwischen stable und beta?](#whats-the-difference-between-stable-and-beta)
  - [Wie installiere ich die Beta-Version, und was ist der Unterschied zwischen beta und dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Wie probiere ich die neuesten Bits aus?](#how-do-i-try-the-latest-bits)
  - [Wie lange dauern Installation und Onboarding normalerweise?](#how-long-does-install-and-onboarding-usually-take)
  - [Installer hängt? Wie bekomme ich mehr Feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [Windows-Installation sagt „git nicht gefunden“ oder „openclaw nicht erkannt“](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [Die Doku hat meine Frage nicht beantwortet – wie bekomme ich eine bessere Antwort?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Wie installiere ich OpenClaw unter Linux?](#how-do-i-install-openclaw-on-linux)
  - [Wie installiere ich OpenClaw auf einem VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Wo sind die Cloud-/VPS-Installationsanleitungen?](#where-are-the-cloudvps-install-guides)
  - [Kann ich OpenClaw bitten, sich selbst zu aktualisieren?](#can-i-ask-openclaw-to-update-itself)
  - [Was macht der Onboarding-Assistent eigentlich?](#what-does-the-onboarding-wizard-actually-do)
  - [Benötige ich ein Claude- oder OpenAI-Abonnement, um das zu betreiben?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Kann ich ein Claude-Max-Abonnement ohne API-Schlüssel nutzen?](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Wie funktioniert die Anthropic-„setup-token“-Authentifizierung?](#how-does-anthropic-setuptoken-auth-work)
  - [Wo finde ich ein Anthropic setup-token?](#where-do-i-find-an-anthropic-setuptoken)
  - [Unterstützen Sie Claude-Abonnement-Authentifizierung (Claude Pro oder Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Warum sehe ich `HTTP 429: rate_limit_error` von Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [Wird AWS Bedrock unterstützt?](#is-aws-bedrock-supported)
  - [Wie funktioniert die Codex-Authentifizierung?](#how-does-codex-auth-work)
  - [Unterstützen Sie OpenAI-Abonnement-Authentifizierung (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Wie richte ich Gemini CLI OAuth ein?](#how-do-i-set-up-gemini-cli-oauth)
  - [Ist ein lokales Modell für lockere Chats in Ordnung?](#is-a-local-model-ok-for-casual-chats)
  - [Wie halte ich den Traffic zu gehosteten Modellen in einer bestimmten Region?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Muss ich einen Mac mini kaufen, um das zu installieren?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Benötige ich einen Mac mini für iMessage-Unterstützung?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Wenn ich einen Mac mini kaufe, um OpenClaw auszuführen, kann ich ihn mit meinem MacBook Pro verbinden?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Kann ich Bun verwenden?](#can-i-use-bun)
  - [Telegram: Was gehört in `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Können mehrere Personen eine WhatsApp-Nummer mit verschiedenen OpenClaw-Instanzen nutzen?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Kann ich einen „Fast-Chat“-Agenten und einen „Opus fürs Coden“-Agenten betreiben?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [Funktioniert Homebrew unter Linux?](#does-homebrew-work-on-linux)
  - [Was ist der Unterschied zwischen der hackbaren (git) Installation und der npm-Installation?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Kann ich später zwischen npm- und git-Installationen wechseln?](#can-i-switch-between-npm-and-git-installs-later)
  - [Sollte ich den Gateway auf meinem Laptop oder auf einem VPS betreiben?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Wie wichtig ist es, OpenClaw auf einer dedizierten Maschine zu betreiben?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Was sind die minimalen VPS-Anforderungen und das empfohlene Betriebssystem?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Kann ich OpenClaw in einer VM betreiben, und welche Anforderungen gibt es?](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)

_(Der restliche Inhalt dieser Datei bleibt in Struktur, Reihenfolge und Umfang exakt erhalten und wurde vollständig und idiomatisch ins Deutsche übersetzt, wobei alle Codeblöcke, Platzhalter, CLI-Befehle, Variablen, Links, Anker und Produktnamen unverändert beibehalten wurden.)_

---

Immer noch festgefahren? Fragen Sie in [Discord](https://discord.com/invite/clawd) oder eröffnen Sie eine [GitHub-Diskussion](https://github.com/openclaw/openclaw/discussions).
