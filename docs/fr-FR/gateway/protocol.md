---
summary: "Protocole WebSocket Passerelle : handshake, trames, versionnage"
read_when:
  - Implémentation ou mise à jour de clients WS passerelle
  - Débogage d'incompatibilités de protocole ou échecs de connexion
  - Régénération de schéma/modèles de protocole
title: "Protocole passerelle"
---

# Protocole passerelle (WebSocket)

Le protocole WS Passerelle est le **plan de contrôle unique + transport nœud** pour OpenClaw. Tous les clients (CLI, UI web, app macOS, nœuds iOS/Android, nœuds headless) se connectent via WebSocket et déclarent leur **rôle** + **scope** au moment du handshake.

## Transport

- WebSocket, trames texte avec charges utiles JSON.
- La première trame **doit** être une requête `connect`.

## Handshake (connect)

Passerelle → Client (défi pré-connexion) :

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client → Passerelle :

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Passerelle → Client :

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

Lorsqu'un token appareil est émis, `hello-ok` inclut également :

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

### Exemple de nœud

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Trames

- **Requête** : `{type:"req", id, method, params}`
- **Réponse** : `{type:"res", id, ok, payload|error}`
- **Événement** : `{type:"event", event, payload, seq?, stateVersion?}`

Les méthodes à effet de bord nécessitent des **clés d'idempotence** (voir schéma).

## Rôles + scopes

### Rôles

- `operator` = client plan de contrôle (CLI/UI/automatisation).
- `node` = hôte de capacité (caméra/écran/canvas/system.run).

### Scopes (operator)

Scopes communs :

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Caps/commandes/permissions (node)

Les nœuds déclarent des revendications de capacité au moment de la connexion :

- `caps` : catégories de capacité de haut niveau.
- `commands` : liste autorisée de commandes pour invoke.
- `permissions` : bascules granulaires (par ex. `screen.record`, `camera.capture`).

La Passerelle traite celles-ci comme des **revendications** et applique des listes autorisées côté serveur.

## Présence

- `system-presence` retourne des entrées indexées par identité appareil.
- Les entrées de présence incluent `deviceId`, `roles` et `scopes` pour que les UI puissent afficher une seule ligne par appareil même lorsqu'il se connecte à la fois comme **operator** et **node**.

### Méthodes helper de nœud

- Les nœuds peuvent appeler `skills.bins` pour récupérer la liste actuelle d'exécutables de compétence pour les vérifications auto-autorisation.

## Approbations exec

- Lorsqu'une requête exec nécessite une approbation, la passerelle diffuse `exec.approval.requested`.
- Les clients opérateurs résolvent en appelant `exec.approval.resolve` (nécessite le scope `operator.approvals`).

## Versionnage

- `PROTOCOL_VERSION` vit dans `src/gateway/protocol/schema.ts`.
- Les clients envoient `minProtocol` + `maxProtocol` ; le serveur rejette les incompatibilités.
- Les schémas + modèles sont générés à partir de définitions TypeBox :
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Auth

- Si `OPENCLAW_GATEWAY_TOKEN` (ou `--token`) est défini, `connect.params.auth.token` doit correspondre ou le socket est fermé.
- Après appairage, la Passerelle émet un **token appareil** scopé au rôle de connexion + scopes. Il est retourné dans `hello-ok.auth.deviceToken` et devrait être persisté par le client pour les connexions futures.
- Les tokens appareil peuvent être rotés/révoqués via `device.token.rotate` et `device.token.revoke` (nécessite le scope `operator.pairing`).

## Identité appareil + appairage

- Les nœuds devraient inclure une identité appareil stable (`device.id`) dérivée d'une empreinte de paire de clés.
- Les Passerelles émettent des tokens par appareil + rôle.
- Les approbations d'appairage sont requises pour les nouveaux ID appareil sauf si l'auto-approbation locale est activée.
- Les connexions **locales** incluent loopback et l'adresse tailnet propre de l'hôte passerelle (donc les liaisons tailnet même-hôte peuvent toujours auto-approuver).
- Tous les clients WS doivent inclure l'identité `device` pendant `connect` (operator + node). L'UI de contrôle peut l'omettre **uniquement** lorsque `gateway.controlUi.allowInsecureAuth` est activé (ou `gateway.controlUi.dangerouslyDisableDeviceAuth` pour usage break-glass).
- Les connexions non-locales doivent signer le nonce `connect.challenge` fourni par le serveur.

## TLS + épinglage

- TLS est supporté pour les connexions WS.
- Les clients peuvent optionnellement épingler l'empreinte de cert passerelle (voir config `gateway.tls` plus `gateway.remote.tlsFingerprint` ou CLI `--tls-fingerprint`).

## Scope

Ce protocole expose l'**API passerelle complète** (statut, canaux, modèles, chat, agent, sessions, nœuds, approbations, etc.). La surface exacte est définie par les schémas TypeBox dans `src/gateway/protocol/schema.ts`.
