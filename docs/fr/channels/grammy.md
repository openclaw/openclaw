---
summary: "Integration de l’API Telegram Bot via grammY avec des notes de configuration"
read_when:
  - Travail sur des parcours Telegram ou grammY
title: grammY
---

# Integration grammY (API Telegram Bot)

# Pourquoi grammY

- Client d’API Bot « TS-first » avec helpers integres pour long-poll + webhook, middleware, gestion des erreurs, limiteur de debit.
- Helpers media plus propres que l’assemblage manuel fetch + FormData ; prend en charge toutes les methodes de l’API Bot.
- Extensible : prise en charge des proxys via fetch personnalise, middleware de session (optionnel), contexte type-safe.

# Ce que nous avons livre

- **Chemin client unique :** l’implementation basee sur fetch a ete supprimee ; grammY est desormais l’unique client Telegram (envoi + gateway) avec le limiteur grammY active par defaut.
- **Gateway (passerelle) :** `monitorTelegramProvider` construit un `Bot` grammY, raccorde le filtrage par mention/liste d’autorisation, le telechargement de media via `getFile`/`download`, et delivre les reponses avec `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Prend en charge le long-poll ou le webhook via `webhookCallback`.
- **Proxy :** l’option `channels.telegram.proxy` utilise `undici.ProxyAgent` via le `client.baseFetch` de grammY.
- **Prise en charge des webhooks :** `webhook-set.ts` encapsule `setWebhook/deleteWebhook` ; `webhook.ts` heberge le callback avec sante + arret gracieux. La Gateway active le mode webhook lorsque `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` sont definis (sinon, elle utilise le long-poll).
- **Sessions :** les discussions directes sont fusionnees dans la session principale de l’agent (`agent:<agentId>:<mainKey>`) ; les groupes utilisent `agent:<agentId>:telegram:group:<chatId>` ; les reponses reviennent vers le meme canal.
- **Parametres de configuration :** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (liste d’autorisation + valeurs par defaut des mentions), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Streaming de brouillon :** l’option `channels.telegram.streamMode` utilise `sendMessageDraft` dans les discussions de sujets prives (API Bot 9.3+). Ceci est distinct du streaming de blocs de canaux.
- **Tests :** les mocks grammY couvrent le filtrage DM + mentions de groupe et l’envoi sortant ; d’autres fixtures media/webhook sont encore bienvenues.

Questions ouvertes

- Plugins grammY optionnels (limiteur) si nous rencontrons des 429 de l’API Bot.
- Ajouter davantage de tests media structures (stickers, messages vocaux).
- Rendre le port d’ecoute du webhook configurable (actuellement fixe a 8787 sauf s’il est raccorde via la gateway).
