---
summary: "Protocole WebSocket de la Gateway (passerelle) : handshake, trames, versionnage"
read_when:
  - Implémentation ou mise à jour des clients WS de la Gateway (passerelle)
  - Débogage des incompatibilités de protocole ou des échecs de connexion
  - Régénération du schéma/des modèles du protocole
title: "Protocole de la Gateway (passerelle)"
---

# Protocole de la Gateway (passerelle) (WebSocket)

Le protocole WS de la Gateway (passerelle) est le **plan de contrôle unique + transport des nœuds** pour
OpenClaw. Tous les clients (CLI, UI web, app macOS, nœuds iOS/Android, nœuds headless)
se connectent via WebSocket et déclarent leur **rôle** + **périmètre (scope)** au moment
du handshake.

## Transport

- WebSocket, trames texte avec charges utiles JSON.
- La première trame **doit** être une requête `connect`.

## Handshake (connexion)

Gateway (passerelle) → Client (défi pré-connexion) :

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client → Gateway (passerelle) :

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

Gateway (passerelle) → Client :

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": { "type": "hello-ok", "protocol": 3, "policy": { "tickIntervalMs": 15000 } }
}
```

Lorsqu’un jeton d’appareil est émis, `hello-ok` inclut également :

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

## Encadrement

- **Requête** : `{type:"req", id, method, params}`
- **Réponse** : `{type:"res", id, ok, payload|error}`
- **Événement** : `{type:"event", event, payload, seq?, stateVersion?}`

Les méthodes ayant des effets de bord nécessitent des **clés d’idempotence** (voir le schéma).

## Rôles + périmètres (scopes)

### Rôles

- `operator` = client du plan de contrôle (CLI/UI/automatisation).
- `node` = hôte de capacités (camera/screen/canvas/system.run).

### Périmètres (opérateur)

Portées communes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`

### Capacités/commandes/permissions (nœud)

Les nœuds déclarent des revendications de capacités au moment de la connexion :

- `caps` : catégories de capacités de haut niveau.
- `commands` : liste d’autorisations de commandes pour l’invocation.
- `permissions` : bascules granulaires (p. ex. `screen.record`, `camera.capture`).

La Gateway (passerelle) traite celles-ci comme des **revendications** et applique des listes d’autorisation côté serveur.

## Présence

- `system-presence` renvoie des entrées indexées par l’identité de l’appareil.
- Les entrées de présence incluent `deviceId`, `roles` et `scopes` afin que les UI puissent afficher une seule ligne par appareil
  même lorsqu’il se connecte à la fois en tant qu’**opérateur** et **nœud**.

### Méthodes d’assistance pour les nœuds

- Les nœuds peuvent appeler `skills.bins` pour récupérer la liste actuelle des exécutables de Skills
  afin d’effectuer des vérifications d’auto‑autorisation.

## Approbations d’exécution

- Lorsqu’une requête d’exécution nécessite une approbation, la gateway diffuse `exec.approval.requested`.
- Les clients opérateurs résolvent en appelant `exec.approval.resolve` (nécessite le périmètre `operator.approvals`).

## Versionnage

- `PROTOCOL_VERSION` réside dans `src/gateway/protocol/schema.ts`.
- Les clients envoient `minProtocol` + `maxProtocol` ; le serveur rejette les incompatibilités.
- Les schémas + modèles sont générés à partir de définitions TypeBox :
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

## Authentification

- Si `OPENCLAW_GATEWAY_TOKEN` (ou `--token`) est défini, `connect.params.auth.token`
  doit correspondre, sinon le socket est fermé.
- Après l’appairage, la Gateway (passerelle) émet un **jeton d’appareil** limité au rôle + aux périmètres de la connexion. Il est renvoyé dans `hello-ok.auth.deviceToken` et doit être
  persisté par le client pour les connexions ultérieures.
- Les jetons d’appareil peuvent être renouvelés/révoqués via `device.token.rotate` et
  `device.token.revoke` (nécessite le périmètre `operator.pairing`).

## Identité de l’appareil + appairage

- Les nœuds doivent inclure une identité d’appareil stable (`device.id`) dérivée de l’empreinte d’une paire de clés.
- Les gateways émettent des jetons par appareil + rôle.
- Des approbations d’appairage sont requises pour les nouveaux identifiants d’appareil, sauf si l’auto‑approbation locale est activée.
- Les connexions **locales** incluent le loopback et l’adresse tailnet propre à l’hôte de la gateway
  (ainsi, les liaisons tailnet sur le même hôte peuvent toujours être auto‑approuvées).
- Tous les clients WS doivent inclure l’identité `device` pendant `connect` (opérateur + nœud).
  L’UI de contrôle peut l’omettre **uniquement** lorsque `gateway.controlUi.allowInsecureAuth` est activé
  (ou `gateway.controlUi.dangerouslyDisableDeviceAuth` pour un usage « break‑glass »).
- Les connexions non locales doivent signer le nonce `connect.challenge` fourni par le serveur.

## TLS + pinning

- TLS est pris en charge pour les connexions WS.
- Les clients peuvent optionnellement épingler l’empreinte du certificat de la gateway (voir la configuration `gateway.tls`
  ainsi que `gateway.remote.tlsFingerprint` ou le CLI `--tls-fingerprint`).

## Périmètre d'application

Ce protocole expose **l’intégralité de l’API de la gateway** (statut, canaux, modèles, chat,
agent, sessions, nœuds, approbations, etc.). La surface exacte est définie par les schémas TypeBox dans `src/gateway/protocol/schema.ts`.
