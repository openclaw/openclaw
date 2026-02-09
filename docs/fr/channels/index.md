---
summary: "Plateformes de messagerie auxquelles OpenClaw peut se connecter"
read_when:
  - Vous souhaitez choisir un canal de chat pour OpenClaw
  - Vous avez besoin d'un aperçu rapide des plateformes de messagerie prises en charge
title: "Canaux de chat"
---

# Canaux de chat

OpenClaw peut vous parler sur n'importe quelle application de chat que vous utilisez deja. Chaque canal se connecte via le Gateway (passerelle).
Le texte est pris en charge partout ; les medias et les reactions varient selon le canal.

## Canaux pris en charge

- [WhatsApp](/channels/whatsapp) — Le plus populaire ; utilise Baileys et necessite un appairage par QR.
- [Telegram](/channels/telegram) — API Bot via grammY ; prend en charge les groupes.
- [Discord](/channels/discord) — API Bot Discord + Gateway (passerelle) ; prend en charge les serveurs, les canaux et les Messages prives.
- [Slack](/channels/slack) — SDK Bolt ; applications d'espace de travail.
- [Feishu](/channels/feishu) — Bot Feishu/Lark via WebSocket (plugin, installe separement).
- [Google Chat](/channels/googlechat) — Application Google Chat API via webhook HTTP.
- [Mattermost](/channels/mattermost) — API Bot + WebSocket ; canaux, groupes, Messages prives (plugin, installe separement).
- [Signal](/channels/signal) — signal-cli ; axe sur la confidentialite.
- [BlueBubbles](/channels/bluebubbles) — **Recommande pour iMessage** ; utilise l'API REST du serveur macOS BlueBubbles avec une prise en charge complete des fonctionnalites (edition, annulation d'envoi, effets, reactions, gestion des groupes — l'edition est actuellement defectueuse sur macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Integration macOS historique via l'outil imsg CLI (obsolet, utilisez BlueBubbles pour les nouvelles installations).
- [Microsoft Teams](/channels/msteams) — Bot Framework ; prise en charge entreprise (plugin, installe separement).
- [LINE](/channels/line) — Bot LINE Messaging API (plugin, installe separement).
- [Nextcloud Talk](/channels/nextcloud-talk) — Chat auto-heberge via Nextcloud Talk (plugin, installe separement).
- [Matrix](/channels/matrix) — Protocole Matrix (plugin, installe separement).
- [Nostr](/channels/nostr) — Messages prives decentralises via NIP-04 (plugin, installe separement).
- [Tlon](/channels/tlon) — Messagerie basee sur Urbit (plugin, installe separement).
- [Twitch](/channels/twitch) — Chat Twitch via connexion IRC (plugin, installe separement).
- [Zalo](/channels/zalo) — API Bot Zalo ; messagerie populaire au Vietnam (plugin, installe separement).
- [Zalo Personal](/channels/zalouser) — Compte personnel Zalo via connexion QR (plugin, installe separement).
- [WebChat](/web/webchat) — Interface utilisateur WebChat du Gateway (passerelle) via WebSocket.

## Notes

- Les canaux peuvent s'executer simultanement ; configurez-en plusieurs et OpenClaw effectuera le routage par chat.
- La configuration la plus rapide est generalement **Telegram** (jeton de bot simple). WhatsApp necessite un appairage par QR et
  stocke davantage d'etat sur le disque.
- Le comportement des groupes varie selon le canal ; voir [Groups](/concepts/groups).
- L'appairage des Messages prives et les listes d'autorisation sont appliques pour la securite ; voir [Security](/gateway/security).
- Internes Telegram : [notes grammY](/channels/grammy).
- Depannage : [Depannage des canaux](/channels/troubleshooting).
- Les fournisseurs de modeles sont documentes separement ; voir [Model Providers](/providers/models).
