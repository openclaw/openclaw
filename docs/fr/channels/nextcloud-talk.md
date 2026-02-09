---
summary: "Statut de prise en charge, capacites et configuration de Nextcloud Talk"
read_when:
  - Travail sur les fonctionnalites du canal Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

Statut : pris en charge via un plugin (bot webhook). Les messages prives, salons, reactions et messages Markdown sont pris en charge.

## Plugin requis

Nextcloud Talk est fourni sous forme de plugin et n’est pas inclus dans l’installation principale.

Installation via la CLI (registre npm) :

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Extraction locale (lorsqu’execute depuis un depot git) :

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Si vous choisissez Nextcloud Talk lors de la configuration/prise en main et qu’un depot git est detecte,
OpenClaw proposera automatiquement le chemin d’installation locale.

Details : [Plugins](/plugin)

## Demarrage rapide (debutant)

1. Installez le plugin Nextcloud Talk.

2. Sur votre serveur Nextcloud, creez un bot :

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Activez le bot dans les parametres du salon cible.

4. Configurez OpenClaw :
   - Config : `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Ou env : `NEXTCLOUD_TALK_BOT_SECRET` (compte par defaut uniquement)

5. Redemarrez la Gateway (passerelle) (ou terminez la prise en main).

Configuration minimale :

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Notes

- Les bots ne peuvent pas initier de Messages prives. L’utilisateur doit d’abord envoyer un message au bot.
- L’URL du webhook doit etre accessible par la Gateway (passerelle) ; definissez `webhookPublicUrl` si vous etes derriere un proxy.
- Les televersements de medias ne sont pas pris en charge par l’API du bot ; les medias sont envoyes sous forme d’URL.
- La charge utile du webhook ne distingue pas Messages prives et salons ; definissez `apiUser` + `apiPassword` pour activer les recherches de type de salon (sinon les Messages prives sont traites comme des salons).

## Contrôle d'accès (DMs)

- Par defaut : `channels.nextcloud-talk.dmPolicy = "pairing"`. Les expediteurs inconnus recoivent un code d’appairage.
- Approuver via :
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Messages prives publics : `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` correspond uniquement aux identifiants utilisateur Nextcloud ; les noms d’affichage sont ignores.

## Salons (groupes)

- Par defaut : `channels.nextcloud-talk.groupPolicy = "allowlist"` (controle par mention).
- Mettre des salons sur liste d’autorisation avec `channels.nextcloud-talk.rooms` :

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Pour n’autoriser aucun salon, laissez la liste d’autorisation vide ou definissez `channels.nextcloud-talk.groupPolicy="disabled"`.

## Capacites

| Fonctionnalite    | Statut             |
| ----------------- | ------------------ |
| Messages directs  | Pris en charge     |
| Salons            | Pris en charge     |
| Fil de discussion | Non pris en charge |
| Medias            | URL uniquement     |
| Reactions         | Pris en charge     |
| Commandes natives | Non pris en charge |

## Reference de configuration (Nextcloud Talk)

Configuration complete : [Configuration](/gateway/configuration)

Options du fournisseur :

- `channels.nextcloud-talk.enabled` : activer/desactiver le demarrage du canal.
- `channels.nextcloud-talk.baseUrl` : URL de l’instance Nextcloud.
- `channels.nextcloud-talk.botSecret` : secret partage du bot.
- `channels.nextcloud-talk.botSecretFile` : chemin du fichier secret.
- `channels.nextcloud-talk.apiUser` : utilisateur API pour les recherches de salons (detection des Messages prives).
- `channels.nextcloud-talk.apiPassword` : mot de passe API/app pour les recherches de salons.
- `channels.nextcloud-talk.apiPasswordFile` : chemin du fichier de mot de passe API.
- `channels.nextcloud-talk.webhookPort` : port d’ecoute du webhook (par defaut : 8788).
- `channels.nextcloud-talk.webhookHost` : hote du webhook (par defaut : 0.0.0.0).
- `channels.nextcloud-talk.webhookPath` : chemin du webhook (par defaut : /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl` : URL du webhook accessible de l’exterieur.
- `channels.nextcloud-talk.dmPolicy` : `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom` : liste d’autorisation des Messages prives (identifiants utilisateur). `open` requiert `"*"`.
- `channels.nextcloud-talk.groupPolicy` : `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom` : liste d’autorisation des groupes (identifiants utilisateur).
- `channels.nextcloud-talk.rooms` : parametres par salon et liste d’autorisation.
- `channels.nextcloud-talk.historyLimit` : limite d’historique des groupes (0 desactive).
- `channels.nextcloud-talk.dmHistoryLimit` : limite d’historique des Messages prives (0 desactive).
- `channels.nextcloud-talk.dms` : remplacements par Message prive (historyLimit).
- `channels.nextcloud-talk.textChunkLimit` : taille des segments de texte sortants (caracteres).
- `channels.nextcloud-talk.chunkMode` : `length` (par defaut) ou `newline` pour segmenter sur les lignes vides (limites de paragraphe) avant la segmentation par longueur.
- `channels.nextcloud-talk.blockStreaming` : desactiver le streaming par blocs pour ce canal.
- `channels.nextcloud-talk.blockStreamingCoalesce` : reglage de fusion du streaming par blocs.
- `channels.nextcloud-talk.mediaMaxMb` : limite des medias entrants (Mo).
