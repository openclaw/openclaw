---
summary: "Canal DM Nostr via messages chiffrés NIP-04"
read_when:
  - Vous voulez qu'OpenClaw reçoive des DM via Nostr
  - Vous configurez la messagerie décentralisée
title: "Nostr"
---

# Nostr

**Statut :** Plugin optionnel (désactivé par défaut).

Nostr est un protocole décentralisé pour le réseau social. Ce canal permet à OpenClaw de recevoir et répondre aux messages directs chiffrés (DM) via NIP-04.

## Installation (à la demande)

### Onboarding (recommandé)

- L'assistant d'onboarding (`openclaw onboard`) et `openclaw channels add` listent les plugins de canal optionnels.
- Sélectionner Nostr vous invite à installer le plugin à la demande.

Installations par défaut :

- **Canal dev + checkout git disponible :** utilise le chemin de plugin local.
- **Stable/Beta :** télécharge depuis npm.

Vous pouvez toujours remplacer le choix dans l'invite.

### Installation manuelle

```bash
openclaw plugins install @openclaw/nostr
```

Utiliser un checkout local (workflows dev) :

```bash
openclaw plugins install --link <chemin-vers-openclaw>/extensions/nostr
```

Redémarrez la Passerelle après installation ou activation de plugins.

## Configuration rapide

1. Générez une paire de clés Nostr (si nécessaire) :

```bash
# Utilisant nak
nak key generate
```

2. Ajoutez à la config :

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

4. Redémarrez la Passerelle.

## Référence de configuration

| Clé          | Type     | Défaut                                      | Description                        |
| ------------ | -------- | ------------------------------------------- | ---------------------------------- |
| `privateKey` | string   | requis                                      | Clé privée au format `nsec` ou hex |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | URLs relais (WebSocket)            |
| `dmPolicy`   | string   | `pairing`                                   | Politique d'accès DM               |
| `allowFrom`  | string[] | `[]`                                        | Pubkeys expéditeurs autorisés      |
| `enabled`    | boolean  | `true`                                      | Activer/désactiver canal           |
| `name`       | string   | -                                           | Nom d'affichage                    |
| `profile`    | object   | -                                           | Métadonnées profil NIP-01          |

## Métadonnées de profil

Les données de profil sont publiées comme événement NIP-01 `kind:0`. Vous pouvez les gérer depuis l'UI de Contrôle (Canaux → Nostr → Profil) ou les définir directement dans la config.

Exemple :

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Bot DM assistant personnel",
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

Notes :

- Les URLs de profil doivent utiliser `https://`.
- L'import depuis les relais fusionne les champs et préserve les remplacements locaux.

## Contrôle d'accès

### Politiques DM

- **pairing** (par défaut) : les expéditeurs inconnus obtiennent un code d'appairage.
- **allowlist** : seuls les pubkeys dans `allowFrom` peuvent envoyer des DM.
- **open** : DM entrants publics (nécessite `allowFrom: ["*"]`).
- **disabled** : ignorer les DM entrants.

### Exemple allowlist

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

## Formats de clé

Formats acceptés :

- **Clé privée :** `nsec...` ou hex 64 caractères
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

- Utilisez 2-3 relais pour la redondance.
- Évitez trop de relais (latence, duplication).
- Les relais payants peuvent améliorer la fiabilité.
- Les relais locaux conviennent pour les tests (`ws://localhost:7777`).

## Support de protocole

| NIP    | Statut   | Description                                   |
| ------ | -------- | --------------------------------------------- |
| NIP-01 | Supporté | Format événement de base + métadonnées profil |
| NIP-04 | Supporté | DM chiffrés (`kind:4`)                        |
| NIP-17 | Prévu    | DM emballés-cadeaux                           |
| NIP-44 | Prévu    | Chiffrement versionné                         |

## Tests

### Relais local

```bash
# Démarrer strfry
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

1. Notez le pubkey bot (npub) depuis les journaux.
2. Ouvrez un client Nostr (Damus, Amethyst, etc.).
3. Envoyez un DM au pubkey bot.
4. Vérifiez la réponse.

## Dépannage

### Pas de réception de messages

- Vérifiez que la clé privée est valide.
- Assurez-vous que les URLs relais sont accessibles et utilisent `wss://` (ou `ws://` pour local).
- Confirmez que `enabled` n'est pas `false`.
- Vérifiez les journaux Passerelle pour les erreurs de connexion relais.

### Pas d'envoi de réponses

- Vérifiez que le relais accepte les écritures.
- Vérifiez la connectivité sortante.
- Surveillez les limites de taux relais.

### Réponses en double

- Attendu lors de l'utilisation de plusieurs relais.
- Les messages sont dédupliqués par ID événement ; seule la première livraison déclenche une réponse.

## Sécurité

- Ne committez jamais les clés privées.
- Utilisez des variables d'environnement pour les clés.
- Considérez `allowlist` pour les bots de production.

## Limitations (MVP)

- Messages directs uniquement (pas de chats de groupe).
- Pas de pièces jointes médias.
- NIP-04 uniquement (emballage-cadeau NIP-17 prévu).

## Voir aussi

- [Plugins](/fr-FR/tools/plugin)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Appairage](/fr-FR/channels/pairing)
