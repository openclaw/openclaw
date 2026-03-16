---
summary: "Plateformes de messagerie auxquelles OpenClaw peut se connecter"
read_when:
  - Vous souhaitez choisir un canal de chat pour OpenClaw
  - Vous avez besoin d'un aperçu rapide des plateformes de messagerie supportées
title: "Canaux de Chat"
---

# Canaux de Chat

OpenClaw peut vous parler sur n'importe quelle application de chat que vous utilisez déjà. Chaque canal se connecte via la Passerelle.
Le texte est supporté partout ; les médias et réactions varient selon le canal.

## Canaux supportés

- [WhatsApp](/fr-FR/channels/whatsapp) — Le plus populaire ; utilise Baileys et nécessite un appairage QR.
- [Telegram](/fr-FR/channels/telegram) — Bot API via grammY ; supporte les groupes.
- [Discord](/fr-FR/channels/discord) — Discord Bot API + Passerelle ; supporte serveurs, canaux et DM.
- [IRC](/fr-FR/channels/irc) — Serveurs IRC classiques ; canaux + DM avec contrôles appairage/allowlist.
- [Slack](/fr-FR/channels/slack) — Bolt SDK ; applications d'espace de travail.
- [Feishu](/fr-FR/channels/feishu) — Bot Feishu/Lark via WebSocket (plugin, installé séparément).
- [Google Chat](/fr-FR/channels/googlechat) — Application Google Chat API via webhook HTTP.
- [Mattermost](/fr-FR/channels/mattermost) — Bot API + WebSocket ; canaux, groupes, DM (plugin, installé séparément).
- [Signal](/fr-FR/channels/signal) — signal-cli ; axé sur la confidentialité.
- [BlueBubbles](/fr-FR/channels/bluebubbles) — **Recommandé pour iMessage** ; utilise l'API REST du serveur macOS BlueBubbles avec support complet des fonctionnalités (édition, annulation d'envoi, effets, réactions, gestion de groupe — édition actuellement cassée sur macOS 26 Tahoe).
- [iMessage (legacy)](/fr-FR/channels/imessage) — Intégration macOS legacy via imsg CLI (obsolète, utilisez BlueBubbles pour les nouvelles installations).
- [Microsoft Teams](/fr-FR/channels/msteams) — Bot Framework ; support entreprise (plugin, installé séparément).
- [LINE](/fr-FR/channels/line) — Bot LINE Messaging API (plugin, installé séparément).
- [Nextcloud Talk](/fr-FR/channels/nextcloud-talk) — Chat auto-hébergé via Nextcloud Talk (plugin, installé séparément).
- [Matrix](/fr-FR/channels/matrix) — Protocole Matrix (plugin, installé séparément).
- [Nostr](/fr-FR/channels/nostr) — DM décentralisés via NIP-04 (plugin, installé séparément).
- [Tlon](/fr-FR/channels/tlon) — Messagerie basée Urbit (plugin, installé séparément).
- [Twitch](/fr-FR/channels/twitch) — Chat Twitch via connexion IRC (plugin, installé séparément).
- [Zalo](/fr-FR/channels/zalo) — Zalo Bot API ; messagerie populaire du Vietnam (plugin, installé séparément).
- [Zalo Personnel](/fr-FR/channels/zalouser) — Compte personnel Zalo via connexion QR (plugin, installé séparément).
- [WebChat](/fr-FR/web/webchat) — Interface WebChat de la Passerelle via WebSocket.

## Remarques

- Les canaux peuvent fonctionner simultanément ; configurez-en plusieurs et OpenClaw routera par chat.
- La configuration la plus rapide est généralement **Telegram** (simple token de bot). WhatsApp nécessite un appairage QR et stocke plus d'état sur le disque.
- Le comportement de groupe varie selon le canal ; voir [Groupes](/fr-FR/channels/groups).
- L'appairage DM et les allowlists sont appliqués pour la sécurité ; voir [Sécurité](/fr-FR/gateway/security).
- Internes Telegram : [notes grammY](/fr-FR/channels/grammy).
- Dépannage : [Dépannage des canaux](/fr-FR/channels/troubleshooting).
- Les fournisseurs de modèles sont documentés séparément ; voir [Fournisseurs de Modèles](/fr-FR/providers/models).
