---
summary: "Référence CLI pour `openclaw devices` (appairage d'appareil + rotation/révocation de token)"
read_when:
  - Vous approuvez des demandes d'appairage d'appareil
  - Vous devez faire pivoter ou révoquer des tokens d'appareil
title: "devices"
---

# `openclaw devices`

Gérer les demandes d'appairage d'appareil et les tokens à portée d'appareil.

## Commandes

### `openclaw devices list`

Lister les demandes d'appairage en attente et les appareils appairés.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Approuver une demande d'appairage d'appareil en attente.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Rejeter une demande d'appairage d'appareil en attente.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Faire pivoter un token d'appareil pour un rôle spécifique (optionnellement mettre à jour les scopes).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Révoquer un token d'appareil pour un rôle spécifique.

```
openclaw devices revoke --device <deviceId> --role node
```

## Options courantes

- `--url <url>` : URL WebSocket de Passerelle (vaut par défaut `gateway.remote.url` quand configuré).
- `--token <token>` : Token de Passerelle (si requis).
- `--password <password>` : Mot de passe de Passerelle (auth par mot de passe).
- `--timeout <ms>` : Timeout RPC.
- `--json` : Sortie JSON (recommandé pour le scripting).

Note : quand vous définissez `--url`, la CLI ne se replie pas sur les identifiants de config ou d'environnement.
Passez `--token` ou `--password` explicitement. Les identifiants explicites manquants sont une erreur.

## Notes

- La rotation de token retourne un nouveau token (sensible). Traitez-le comme un secret.
- Ces commandes nécessitent le scope `operator.pairing` (ou `operator.admin`).
