---
summary: "Plataformas de mensagens às quais o OpenClaw pode se conectar"
read_when:
  - Você quer escolher um canal de chat para o OpenClaw
  - Você precisa de uma visão geral rápida das plataformas de mensagens compatíveis
title: "Canais de Chat"
---

# Canais de Chat

O OpenClaw pode falar com você em qualquer aplicativo de chat que você já usa. Cada canal se conecta via o Gateway.
Texto é suportado em todos; mídia e reações variam conforme o canal.

## Canais suportados

- [WhatsApp](/channels/whatsapp) — Mais popular; usa Baileys e requer pareamento por QR.
- [Telegram](/channels/telegram) — Bot API via grammY; suporta grupos.
- [Discord](/channels/discord) — Discord Bot API + Gateway; suporta servidores, canais e DMs.
- [Slack](/channels/slack) — Bolt SDK; apps de workspace.
- [Feishu](/channels/feishu) — Bot Feishu/Lark via WebSocket (plugin, instalado separadamente).
- [Google Chat](/channels/googlechat) — App da Google Chat API via webhook HTTP.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; canais, grupos, DMs (plugin, instalado separadamente).
- [Signal](/channels/signal) — signal-cli; focado em privacidade.
- [BlueBubbles](/channels/bluebubbles) — **Recomendado para iMessage**; usa a API REST do servidor BlueBubbles no macOS com suporte completo a recursos (editar, desfazer envio, efeitos, reações, gerenciamento de grupos — edição atualmente quebrada no macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Integração legada do macOS via imsg CLI (obsoleto, use BlueBubbles para novas configurações).
- [Microsoft Teams](/channels/msteams) — Bot Framework; suporte corporativo (plugin, instalado separadamente).
- [LINE](/channels/line) — Bot da LINE Messaging API (plugin, instalado separadamente).
- [Nextcloud Talk](/channels/nextcloud-talk) — Chat auto-hospedado via Nextcloud Talk (plugin, instalado separadamente).
- [Matrix](/channels/matrix) — Protocolo Matrix (plugin, instalado separadamente).
- [Nostr](/channels/nostr) — DMs descentralizadas via NIP-04 (plugin, instalado separadamente).
- [Tlon](/channels/tlon) — Mensageiro baseado em Urbit (plugin, instalado separadamente).
- [Twitch](/channels/twitch) — Chat da Twitch via conexão IRC (plugin, instalado separadamente).
- [Zalo](/channels/zalo) — Zalo Bot API; mensageiro popular no Vietnã (plugin, instalado separadamente).
- [Zalo Personal](/channels/zalouser) — Conta pessoal do Zalo via login por QR (plugin, instalado separadamente).
- [WebChat](/web/webchat) — UI WebChat do Gateway sobre WebSocket.

## Notas

- Os canais podem rodar simultaneamente; configure vários e o OpenClaw fará o roteamento por chat.
- A configuração mais rápida geralmente é **Telegram** (token simples de bot). O WhatsApp requer pareamento por QR e
  armazena mais estado em disco.
- O comportamento em grupos varia por canal; veja [Groups](/channels/groups).
- Pareamento de DM e listas de permissões são aplicados por segurança; veja [Security](/gateway/security).
- Internos do Telegram: [notas do grammY](/channels/grammy).
- Solução de problemas: [Solução de problemas de canais](/channels/troubleshooting).
- Provedores de modelos são documentados separadamente; veja [Model Providers](/providers/models).
