---
summary: "Intégration Telegram Bot API via grammY avec notes de configuration"
read_when:
  - Travail sur Telegram ou les chemins grammY
title: grammY
---

# Intégration grammY (Telegram Bot API)

# Pourquoi grammY

- Client Bot API orienté TS avec helpers long-poll + webhook intégrés, middleware, gestion d'erreurs, limiteur de débit.
- Helpers média plus propres que fetch + FormData fait main ; supporte toutes les méthodes Bot API.
- Extensible : support proxy via fetch personnalisé, middleware de session (optionnel), contexte type-safe.

# Ce que nous avons livré

- **Chemin client unique :** implémentation basée fetch supprimée ; grammY est maintenant le seul client Telegram (envoi + passerelle) avec le throttler grammY activé par défaut.
- **Passerelle :** `monitorTelegramProvider` construit un `Bot` grammY, câble le gating mentions/allowlist, téléchargement média via `getFile`/`download`, et délivre les réponses avec `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Supporte long-poll ou webhook via `webhookCallback`.
- **Proxy :** `channels.telegram.proxy` optionnel utilise `undici.ProxyAgent` via `client.baseFetch` de grammY.
- **Support webhook :** `webhook-set.ts` encapsule `setWebhook/deleteWebhook` ; `webhook.ts` héberge le callback avec santé + arrêt gracieux. La Passerelle active le mode webhook lorsque `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` sont définis (sinon long-poll).
- **Sessions :** les chats directs se replient dans la session principale de l'agent (`agent:<agentId>:<mainKey>`) ; les groupes utilisent `agent:<agentId>:telegram:group:<chatId>` ; les réponses sont routées vers le même canal.
- **Boutons de config :** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (allowlist + mentions par défaut), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`, `channels.telegram.webhookHost`.
- **Streaming brouillon :** `channels.telegram.streamMode` optionnel utilise `sendMessageDraft` dans les chats de sujet privés (Bot API 9.3+). Ceci est séparé du streaming de blocs de canal.
- **Tests :** les mocks grammY couvrent le gating mentions DM + groupe et l'envoi sortant ; plus de fixtures média/webhook sont toujours les bienvenues.

Questions ouvertes

- Plugins grammY optionnels (throttler) si nous rencontrons des 429 Bot API.
- Ajouter plus de tests média structurés (stickers, notes vocales).
- Rendre le port d'écoute webhook configurable (actuellement fixé à 8787 sauf si câblé via la passerelle).
