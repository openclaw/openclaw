---
summary: "Canal de messages privés Nostr via des messages chiffrés NIP-04"
read_when:
  - Vous souhaitez qu’OpenClaw reçoive des messages privés via Nostr
  - Vous configurez une messagerie décentralisée
title: "Nostr"
---

# Nostr

**Statut :** plugin optionnel (désactivé par défaut).

Nostr est un protocole décentralisé de réseau social. Ce canal permet à OpenClaw de recevoir et de répondre à des messages privés (DMs) chiffrés via NIP-04.

## Installation (à la demande)

### Intégration (recommandé)

- L’assistant de prise en main (`openclaw onboard`) et `openclaw channels add` listent les plugins de canal optionnels.
- La sélection de Nostr vous invite à installer le plugin à la demande.

Paramètres d’installation par défaut :

- **Canal Dev + git checkout disponible :** utilise le chemin du plugin local.
- **Stable/Beta :** télécharge depuis npm.

Vous pouvez toujours remplacer le choix dans l'invite de presse.

### Installation manuelle

```bash
openclaw plugins install @openclaw/nostr
```

Utiliser un checkout local (workflows de développement) :

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Redémarrez la Gateway après l’installation ou l’activation des plugins.

## Demarrage rapide

1. Générez une paire de clés Nostr (si nécessaire) :

```bash
# Using nak
nak key generate
```

2. Ajoutez à la configuration :

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Exportez la clé :

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Redémarrez la Gateway.

## Référence de configuration

| Clé          | Type                                                         | Par défaut                                  | Description                                   |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------- |
| `privateKey` | string                                                       | required                                    | Clé privée au format `nsec` ou hex            |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | URL des relais (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | Politique d’accès aux DM                      |
| `allowFrom`  | string[] | `[]`                                        | Pubkeys d’expéditeurs autorisés               |
| `enabled`    | boolean                                                      | `true`                                      | Activer/désactiver le canal                   |
| `name`       | string                                                       | -                                           | Nom d’affichage                               |
| `profile`    | object                                                       | -                                           | Métadonnées de profil NIP-01                  |

## Métadonnées de profil

Les données de profil sont publiées sous forme d’événement NIP-01 `kind:0`. Vous pouvez les gérer depuis l’UI de contrôle (Canaux -> Nostr -> Profil) ou les définir directement dans la configuration.

Exemple :

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

Remarques :

- Les URL de profil doivent utiliser `https://`.
- L’importation depuis des relais fusionne les champs et conserve les remplacements locaux.

## Contrôle d’accès

### Politiques de DM

- **pairing** (par défaut) : les expéditeurs inconnus reçoivent un code d’appairage.
- **allowlist** : seules les pubkeys dans `allowFrom` peuvent envoyer des DM.
- **open** : DM entrants publics (nécessite `allowFrom: ["*"]`).
- **disabled** : ignorer les DM entrants.

### Exemple d’allowlist

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Formats de clés

Formats acceptés :

- **Clé privée :** `nsec...` ou hex de 64 caractères
- **Pubkeys (`allowFrom`) :** `npub...` ou hex

## Relais

Par défaut : `relay.damus.io` et `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

Conseils :

- Utilisez 2 à 3 relais pour la redondance.
- Évitez trop de relais (latence, duplication).
- Les relais payants peuvent améliorer la fiabilité.
- Les relais locaux conviennent pour les tests (`ws://localhost:7777`).

## Support du protocole

| NIP    | Statut         | Description                                         |
| ------ | -------------- | --------------------------------------------------- |
| NIP-01 | Pris en charge | Format d’événement de base + métadonnées de profil  |
| NIP-04 | Pris en charge | DM chiffrés (`kind:4`)           |
| NIP-17 | Planifié       | DM enveloppés (« gift-wrapped ») |
| NIP-44 | Planifié       | Chiffrement versionné                               |

## Tests

### Relais local

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Test manuel

1. Notez la pubkey du bot (npub) depuis les logs.
2. Ouvrez un client Nostr (Damus, Amethyst, etc.).
3. Envoyez un DM à la pubkey du bot.
4. Vérifiez la réponse.

## Problemes courants

### Réception de messages impossible

- Vérifiez que la clé privée est valide.
- Assurez-vous que les URL des relais sont accessibles et utilisent `wss://` (ou `ws://` en local).
- Confirmez que `enabled` n’est pas `false`.
- Consultez les logs de la Gateway pour les erreurs de connexion aux relais.

### Envoi de réponses impossible

- Vérifiez que le relais accepte les écritures.
- Vérifiez la connectivité sortante.
- Surveillez les limites de débit des relais.

### Réponses dupliquées

- Attendu lors de l’utilisation de plusieurs relais.
- Les messages sont dédupliqués par ID d’événement ; seule la première livraison déclenche une réponse.

## Sécurité

- Ne commitez jamais les clés privées.
- Utilisez des variables d’environnement pour les clés.
- Envisagez `allowlist` pour les bots en production.

## Limitations (MVP)

- Messages privés uniquement (pas de discussions de groupe).
- Pas de pièces jointes multimédia.
- NIP-04 uniquement (NIP-17 « gift-wrap » planifié).
