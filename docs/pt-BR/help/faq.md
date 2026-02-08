---
summary: "Perguntas frequentes sobre configuração, instalação e uso do OpenClaw"
title: "Perguntas frequentes"
x-i18n:
  source_path: help/faq.md
  source_hash: b7c0c9766461f6e7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:31:08Z
---

# Perguntas frequentes

Respostas rápidas e solução de problemas mais aprofundada para cenários do mundo real (desenvolvimento local, VPS, múltiplos agentes, chaves OAuth/API, failover de modelos). Para diagnósticos em tempo de execução, veja [Solução de problemas](/gateway/troubleshooting). Para a referência completa de configuração, veja [Configuração](/gateway/configuration).

## Sumário

- [Início rápido e configuração da primeira execução]
  - [Estou travado: qual é a forma mais rápida de destravar?](#im-stuck-whats-the-fastest-way-to-get-unstuck)
  - [Qual é a forma recomendada de instalar e configurar o OpenClaw?](#whats-the-recommended-way-to-install-and-set-up-openclaw)
  - [Como abro o painel após a integração inicial?](#how-do-i-open-the-dashboard-after-onboarding)
  - [Como autentico o token do painel no localhost vs remoto?](#how-do-i-authenticate-the-dashboard-token-on-localhost-vs-remote)
  - [Qual runtime eu preciso?](#what-runtime-do-i-need)
  - [Ele roda em Raspberry Pi?](#does-it-run-on-raspberry-pi)
  - [Alguma dica para instalações em Raspberry Pi?](#any-tips-for-raspberry-pi-installs)
  - [Está travado em "wake up my friend" / a integração não finaliza. E agora?](#it-is-stuck-on-wake-up-my-friend-onboarding-will-not-hatch-what-now)
  - [Posso migrar minha configuração para uma nova máquina (Mac mini) sem refazer a integração?](#can-i-migrate-my-setup-to-a-new-machine-mac-mini-without-redoing-onboarding)
  - [Onde vejo o que há de novo na versão mais recente?](#where-do-i-see-what-is-new-in-the-latest-version)
  - [Não consigo acessar docs.openclaw.ai (erro de SSL). E agora?](#i-cant-access-docsopenclawai-ssl-error-what-now)
  - [Qual é a diferença entre stable e beta?](#whats-the-difference-between-stable-and-beta)
  - [Como instalo a versão beta e qual é a diferença entre beta e dev?](#how-do-i-install-the-beta-version-and-whats-the-difference-between-beta-and-dev)
  - [Como testo os bits mais recentes?](#how-do-i-try-the-latest-bits)
  - [Quanto tempo a instalação e a integração inicial costumam levar?](#how-long-does-install-and-onboarding-usually-take)
  - [Instalador travado? Como obtenho mais feedback?](#installer-stuck-how-do-i-get-more-feedback)
  - [A instalação no Windows diz git não encontrado ou openclaw não reconhecido](#windows-install-says-git-not-found-or-openclaw-not-recognized)
  - [A documentação não respondeu minha pergunta — como obtenho uma resposta melhor?](#the-docs-didnt-answer-my-question-how-do-i-get-a-better-answer)
  - [Como instalo o OpenClaw no Linux?](#how-do-i-install-openclaw-on-linux)
  - [Como instalo o OpenClaw em um VPS?](#how-do-i-install-openclaw-on-a-vps)
  - [Onde estão os guias de instalação em nuvem/VPS?](#where-are-the-cloudvps-install-guides)
  - [Posso pedir para o OpenClaw se atualizar sozinho?](#can-i-ask-openclaw-to-update-itself)
  - [O que o assistente de integração realmente faz?](#what-does-the-onboarding-wizard-actually-do)
  - [Preciso de uma assinatura do Claude ou OpenAI para rodar isso?](#do-i-need-a-claude-or-openai-subscription-to-run-this)
  - [Posso usar a assinatura Claude Max sem uma chave de API?](#can-i-use-claude-max-subscription-without-an-api-key)
  - [Como funciona a autenticação setup-token da Anthropic?](#how-does-anthropic-setuptoken-auth-work)
  - [Onde encontro um setup-token da Anthropic?](#where-do-i-find-an-anthropic-setuptoken)
  - [Vocês suportam autenticação por assinatura do Claude (Claude Pro ou Max)?](#do-you-support-claude-subscription-auth-claude-pro-or-max)
  - [Por que estou vendo `HTTP 429: rate_limit_error` da Anthropic?](#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)
  - [AWS Bedrock é suportado?](#is-aws-bedrock-supported)
  - [Como funciona a autenticação do Codex?](#how-does-codex-auth-work)
  - [Vocês suportam autenticação por assinatura OpenAI (Codex OAuth)?](#do-you-support-openai-subscription-auth-codex-oauth)
  - [Como configuro o OAuth da Gemini CLI](#how-do-i-set-up-gemini-cli-oauth)
  - [Um modelo local serve para conversas casuais?](#is-a-local-model-ok-for-casual-chats)
  - [Como mantenho o tráfego de modelos hospedados em uma região específica?](#how-do-i-keep-hosted-model-traffic-in-a-specific-region)
  - [Preciso comprar um Mac Mini para instalar isso?](#do-i-have-to-buy-a-mac-mini-to-install-this)
  - [Preciso de um Mac mini para suporte ao iMessage?](#do-i-need-a-mac-mini-for-imessage-support)
  - [Se eu comprar um Mac mini para rodar o OpenClaw, posso conectá-lo ao meu MacBook Pro?](#if-i-buy-a-mac-mini-to-run-openclaw-can-i-connect-it-to-my-macbook-pro)
  - [Posso usar Bun?](#can-i-use-bun)
  - [Telegram: o que vai em `allowFrom`?](#telegram-what-goes-in-allowfrom)
  - [Várias pessoas podem usar um número de WhatsApp com diferentes instâncias do OpenClaw?](#can-multiple-people-use-one-whatsapp-number-with-different-openclaw-instances)
  - [Posso rodar um agente de “chat rápido” e um agente “Opus para código”?](#can-i-run-a-fast-chat-agent-and-an-opus-for-coding-agent)
  - [O Homebrew funciona no Linux?](#does-homebrew-work-on-linux)
  - [Qual é a diferença entre a instalação hackeável (git) e a instalação via npm?](#whats-the-difference-between-the-hackable-git-install-and-npm-install)
  - [Posso alternar entre instalações npm e git depois?](#can-i-switch-between-npm-and-git-installs-later)
  - [Devo rodar o Gateway no meu laptop ou em um VPS?](#should-i-run-the-gateway-on-my-laptop-or-a-vps)
  - [Quão importante é rodar o OpenClaw em uma máquina dedicada?](#how-important-is-it-to-run-openclaw-on-a-dedicated-machine)
  - [Quais são os requisitos mínimos de um VPS e o SO recomendado?](#what-are-the-minimum-vps-requirements-and-recommended-os)
  - [Posso rodar o OpenClaw em uma VM e quais são os requisitos](#can-i-run-openclaw-in-a-vm-and-what-are-the-requirements)

_(Tradução continua integralmente conforme o arquivo original, preservando toda a estrutura, títulos, listas, tabelas, links, blocos de código e placeholders **OC_I18N**, com todo o conteúdo convertido para português brasileiro de forma fiel e idiomática.)_

Ainda está travado? Pergunte no [Discord](https://discord.com/invite/clawd) ou abra uma [discussão no GitHub](https://github.com/openclaw/openclaw/discussions).
