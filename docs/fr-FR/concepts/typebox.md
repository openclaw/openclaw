---
summary: "Schémas TypeBox comme source unique de vérité pour le protocole de passerelle"
read_when:
  - Mettre à jour les schémas de protocole ou la génération de code
title: "TypeBox"
---

# TypeBox comme source de vérité du protocole

Dernière mise à jour : 2026-01-10

TypeBox est une bibliothèque de schéma TypeScript-first. Nous l'utilisons pour définir le **protocole
WebSocket de passerelle** (handshake, requête/réponse, événements serveur). Ces schémas
pilotent la **validation d'exécution**, **l'export de schéma JSON** et la **génération de code Swift** pour
l'app macOS. Une source de vérité ; tout le reste est généré.

Si vous voulez le contexte de protocole de plus haut niveau, commencez avec
[Architecture de passerelle](/fr-FR/concepts/architecture).

## Modèle mental (30 secondes)

Chaque message WS de passerelle est l'une des trois trames :

- **Requête** : `{ type: "req", id, method, params }`
- **Réponse** : `{ type: "res", id, ok, payload | error }`
- **Événement** : `{ type: "event", event, payload, seq?, stateVersion? }`

La première trame **doit** être une requête `connect`. Après cela, les clients peuvent appeler
des méthodes (ex. `health`, `send`, `chat.send`) et s'abonner aux événements (ex.
`presence`, `tick`, `agent`).

Flux de connexion (minimal) :

```
Client                    Passerelle
  |---- req:connect -------->|
  |<---- res:hello-ok --------|
  |<---- event:tick ----------|
  |---- req:health ---------->|
  |<---- res:health ----------|
```

Méthodes + événements courants :

| Catégorie  | Exemples                                                  | Notes                                     |
| ---------- | --------------------------------------------------------- | ----------------------------------------- |
| Noyau      | `connect`, `health`, `status`                             | `connect` doit être le premier            |
| Messagerie | `send`, `poll`, `agent`, `agent.wait`                     | side-effects nécessitent `idempotencyKey` |
| Chat       | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`  | WebChat utilise ceux-ci                   |
| Sessions   | `sessions.list`, `sessions.patch`, `sessions.delete`      | admin de session                          |
| Nœuds      | `node.list`, `node.invoke`, `node.pair.*`                 | WS de passerelle + actions de nœud        |
| Événements | `tick`, `presence`, `agent`, `chat`, `health`, `shutdown` | push serveur                              |

La liste autoritaire vit dans `src/gateway/server.ts` (`METHODS`, `EVENTS`).

## Où vivent les schémas

- Source : `src/gateway/protocol/schema.ts`
- Validateurs d'exécution (AJV) : `src/gateway/protocol/index.ts`
- Handshake serveur + dispatch de méthode : `src/gateway/server.ts`
- Client de nœud : `src/gateway/client.ts`
- Schéma JSON généré : `dist/protocol.schema.json`
- Modèles Swift générés : `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift`

## Pipeline actuel

- `pnpm protocol:gen`
  - écrit le schéma JSON (draft-07) vers `dist/protocol.schema.json`
- `pnpm protocol:gen:swift`
  - génère les modèles de passerelle Swift
- `pnpm protocol:check`
  - exécute les deux générateurs et vérifie que la sortie est commitée

## Comment les schémas sont utilisés à l'exécution

- **Côté serveur** : chaque trame entrante est validée avec AJV. Le handshake n'accepte
  qu'une requête `connect` dont les params correspondent à `ConnectParams`.
- **Côté client** : le client JS valide les trames d'événement et de réponse avant
  de les utiliser.
- **Surface de méthode** : la Passerelle annonce les `methods` et
  `events` supportés dans `hello-ok`.

## Exemples de trames

Connexion (premier message) :

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "minProtocol": 2,
    "maxProtocol": 2,
    "client": {
      "id": "openclaw-macos",
      "displayName": "macos",
      "version": "1.0.0",
      "platform": "macos 15.1",
      "mode": "ui",
      "instanceId": "A1B2"
    }
  }
}
```

Réponse Hello-ok :

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 2,
    "server": { "version": "dev", "connId": "ws-1" },
    "features": { "methods": ["health"], "events": ["tick"] },
    "snapshot": {
      "presence": [],
      "health": {},
      "stateVersion": { "presence": 0, "health": 0 },
      "uptimeMs": 0
    },
    "policy": { "maxPayload": 1048576, "maxBufferedBytes": 1048576, "tickIntervalMs": 30000 }
  }
}
```

Requête + réponse :

```json
{ "type": "req", "id": "r1", "method": "health" }
```

```json
{ "type": "res", "id": "r1", "ok": true, "payload": { "ok": true } }
```

Événement :

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1730000000 }, "seq": 12 }
```

## Client minimal (Node.js)

Flux minimal utile : connexion + health.

```ts
import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:18789");

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "cli",
          displayName: "example",
          version: "dev",
          platform: "node",
          mode: "cli",
        },
      },
    }),
  );
});

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === "res" && msg.id === "c1" && msg.ok) {
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
  }
  if (msg.type === "res" && msg.id === "h1") {
    console.log("health:", msg.payload);
    ws.close();
  }
});
```

## Exemple détaillé : ajouter une méthode de bout en bout

Exemple : ajouter une nouvelle requête `system.echo` qui retourne `{ ok: true, text }`.

1. **Schéma (source de vérité)**

Ajoutez à `src/gateway/protocol/schema.ts` :

```ts
export const SystemEchoParamsSchema = Type.Object(
  { text: NonEmptyString },
  { additionalProperties: false },
);

export const SystemEchoResultSchema = Type.Object(
  { ok: Type.Boolean(), text: NonEmptyString },
  { additionalProperties: false },
);
```

Ajoutez les deux à `ProtocolSchemas` et exportez les types :

```ts
  SystemEchoParams: SystemEchoParamsSchema,
  SystemEchoResult: SystemEchoResultSchema,
```

```ts
export type SystemEchoParams = Static<typeof SystemEchoParamsSchema>;
export type SystemEchoResult = Static<typeof SystemEchoResultSchema>;
```

2. **Validation**

Dans `src/gateway/protocol/index.ts`, exportez un validateur AJV :

```ts
export const validateSystemEchoParams = ajv.compile<SystemEchoParams>(SystemEchoParamsSchema);
```

3. **Comportement serveur**

Ajoutez un gestionnaire dans `src/gateway/server-methods/system.ts` :

```ts
export const systemHandlers: GatewayRequestHandlers = {
  "system.echo": ({ params, respond }) => {
    const text = String(params.text ?? "");
    respond(true, { ok: true, text });
  },
};
```

Enregistrez-le dans `src/gateway/server-methods.ts` (fusionne déjà `systemHandlers`),
puis ajoutez `"system.echo"` à `METHODS` dans `src/gateway/server.ts`.

4. **Régénérer**

```bash
pnpm protocol:check
```

5. **Tests + docs**

Ajoutez un test serveur dans `src/gateway/server.*.test.ts` et notez la méthode dans les docs.

## Comportement de génération de code Swift

Le générateur Swift émet :

- L'enum `GatewayFrame` avec les cas `req`, `res`, `event` et `unknown`
- Structs/enums de charge utile fortement typés
- Valeurs `ErrorCode` et `GATEWAY_PROTOCOL_VERSION`

Les types de trame inconnus sont préservés comme charges utiles brutes pour compatibilité future.

## Versionnage + compatibilité

- `PROTOCOL_VERSION` vit dans `src/gateway/protocol/schema.ts`.
- Les clients envoient `minProtocol` + `maxProtocol` ; le serveur rejette les non-correspondances.
- Les modèles Swift gardent les types de trame inconnus pour éviter de casser les anciens clients.

## Modèles de schéma et conventions

- La plupart des objets utilisent `additionalProperties: false` pour des charges utiles strictes.
- `NonEmptyString` est le défaut pour les IDs et noms de méthode/événement.
- Le `GatewayFrame` de niveau supérieur utilise un **discriminateur** sur `type`.
- Les méthodes avec side effects nécessitent généralement un `idempotencyKey` dans params
  (exemple : `send`, `poll`, `agent`, `chat.send`).

## JSON de schéma en direct

Le schéma JSON généré est dans le dépôt à `dist/protocol.schema.json`. Le
fichier brut publié est typiquement disponible à :

- [https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json](https://raw.githubusercontent.com/openclaw/openclaw/main/dist/protocol.schema.json)

## Quand vous changez les schémas

1. Mettez à jour les schémas TypeBox.
2. Exécutez `pnpm protocol:check`.
3. Commitez le schéma régénéré + modèles Swift.
