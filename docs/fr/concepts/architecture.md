---
summary: "Architecture de la passerelle WebSocket, composants et flux clients"
read_when:
  - Travail sur le protocole de la passerelle, les clients ou les transports
title: "Architecture de la passerelle"
---

# Architecture de la passerelle

Derniere mise a jour : 2026-01-22

## Présentation

- Une **Gateway (passerelle)** unique et de longue duree possede toutes les surfaces de messagerie (WhatsApp via
  Baileys, Telegram via grammY, Slack, Discord, Signal, iMessage, WebChat).
- Les clients du plan de controle (application macOS, CLI, interface web, automatisations) se connectent a la
  Gateway via **WebSocket** sur l’hote de bind configure (par defaut
  `127.0.0.1:18789`).
- Les **Nodes** (macOS/iOS/Android/headless) se connectent egalement via **WebSocket**, mais
  declarent `role: node` avec des capacites/commandes explicites.
- Une Gateway par hote ; c’est le seul endroit qui ouvre une session WhatsApp.
- Un **hote de canvas** (par defaut `18793`) sert du HTML editable par l’agent et l’A2UI.

## Composants et flux

### Gateway (daemon)

- Maintient les connexions aux fournisseurs.
- Expose une API WS typee (requetes, reponses, evenements server‑push).
- Valide les trames entrantes par rapport au schema JSON.
- Emet des evenements tels que `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.

### Clients (application mac / CLI / admin web)

- Une connexion WS par client.
- Envoient des requetes (`health`, `status`, `send`, `agent`, `system-presence`).
- S’abonnent aux evenements (`tick`, `agent`, `presence`, `shutdown`).

### Nodes (macOS / iOS / Android / headless)

- Se connectent au **meme serveur WS** avec `role: node`.
- Fournissent une identite d’appareil dans `connect` ; l’appairage est **base sur l’appareil** (role `node`) et
  l’approbation reside dans le magasin d’appairage des appareils.
- Exposent des commandes telles que `canvas.*`, `camera.*`, `screen.record`, `location.get`.

Details du protocole :

- [Gateway protocol](/gateway/protocol)

### WebChat

- Interface statique qui utilise l’API WS de la Gateway pour l’historique de chat et les envois.
- Dans les configurations distantes, se connecte via le meme tunnel SSH/Tailscale que les autres
  clients.

## Cycle de vie de la connexion (client unique)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## Protocole filaire (resume)

- Transport : WebSocket, trames texte avec des charges utiles JSON.
- La premiere trame **doit** etre `connect`.
- Apres l’handshake :
  - Requetes : `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Evenements : `{type:"event", event, payload, seq?, stateVersion?}`
- Si `OPENCLAW_GATEWAY_TOKEN` (ou `--token`) est defini, `connect.params.auth.token`
  doit correspondre, sinon le socket est ferme.
- Des cles d’idempotence sont requises pour les methodes avec effets de bord (`send`, `agent`) afin de
  permettre des reprises sures ; le serveur conserve un cache de deduplication de courte duree.
- Les Nodes doivent inclure `role: "node"` ainsi que les capacites/commandes/autorisations dans `connect`.

## Appairage + confiance locale

- Tous les clients WS (operateurs + nodes) incluent une **identite d’appareil** sur `connect`.
- Les nouveaux IDs d’appareil necessitent une approbation d’appairage ; la Gateway emet un **jeton d’appareil**
  pour les connexions suivantes.
- Les connexions **locales** (loopback ou adresse tailnet propre a l’hote de la passerelle) peuvent etre
  auto‑approuvees afin de garder une UX fluide sur le meme hote.
- Les connexions **non locales** doivent signer le nonce `connect.challenge` et requierent
  une approbation explicite.
- L’authentification de la Gateway (`gateway.auth.*`) s’applique toujours a **toutes** les connexions, locales ou
  distantes.

Details : [Gateway protocol](/gateway/protocol), [Pairing](/start/pairing),
[Security](/gateway/security).

## Typage du protocole et generation de code

- Les schemas TypeBox definissent le protocole.
- Le schema JSON est genere a partir de ces schemas.
- Les modeles Swift sont generes a partir du schema JSON.

## Acces distant

- Recommande : Tailscale ou VPN.

- Alternative : tunnel SSH

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Le meme handshake + jeton d’authentification s’appliquent via le tunnel.

- TLS + pinning optionnel peuvent etre actives pour WS dans les configurations distantes.

## Instantane des operations

- Demarrage : `openclaw gateway` (premier plan, logs vers stdout).
- Sante : `health` via WS (egalement inclus dans `hello-ok`).
- Supervision : launchd/systemd pour le redemarrage automatique.

## Invariants

- Exactement une Gateway controle une seule session Baileys par hote.
- L’handshake est obligatoire ; toute premiere trame non‑JSON ou non‑connect entraine une fermeture immediate.
- Les evenements ne sont pas rejoues ; les clients doivent se rafraichir en cas de lacunes.
