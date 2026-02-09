---
summary: "Reference CLI pour `openclaw devices` (appairage des appareils + rotation/révocation des jetons)"
read_when:
  - Vous approuvez des demandes d’appairage d’appareils
  - Vous devez faire tourner ou révoquer des jetons d’appareil
title: "appareils"
---

# `openclaw devices`

Gérez les demandes d’appairage d’appareils et les jetons à portée d’appareil.

## Commandes

### `openclaw devices list`

Lister les demandes d’appairage en attente et les appareils appairés.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Approuver une demande d’appairage d’appareil en attente.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Rejeter une demande d’appairage d’appareil en attente.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Faire tourner un jeton d’appareil pour un rôle spécifique (avec mise à jour optionnelle des scopes).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Révoquer un jeton d’appareil pour un rôle spécifique.

```
openclaw devices revoke --device <deviceId> --role node
```

## Options communes

- `--url <url>` : URL WebSocket du Gateway (passerelle) (par défaut `gateway.remote.url` lorsqu’elle est configurée).
- `--token <token>` : jeton du Gateway (passerelle) (si requis).
- `--password <password>` : mot de passe du Gateway (passerelle) (authentification par mot de passe).
- `--timeout <ms>` : délai d’expiration RPC.
- `--json` : sortie JSON (recommandée pour le scripting).

Remarque : lorsque vous définissez `--url`, la CLI ne se rabat pas sur la configuration ou les informations d’identification de l’environnement.
Passez `--token` ou `--password` explicitement. L’absence d’informations d’identification explicites est une erreur.

## Notes

- La rotation des jetons renvoie un nouveau jeton (sensible). Traitez-le comme un secret.
- Ces commandes requièrent le scope `operator.pairing` (ou `operator.admin`).
