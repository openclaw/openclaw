---
summary: "Statut support Nextcloud Talk, capacités et configuration"
read_when:
  - Travail sur fonctionnalités canal Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

Statut : supporté via plugin (bot webhook). Messages directs, salles, réactions et messages markdown sont supportés.

## Plugin requis

Nextcloud Talk est fourni comme plugin et n'est pas inclus avec l'installation de base.

Installation via CLI (registre npm) :

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Checkout local (lors de l'exécution depuis un dépôt git) :

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Si vous choisissez Nextcloud Talk pendant configure/onboarding et qu'un checkout git est détecté, OpenClaw offrira automatiquement le chemin d'installation local.

Détails : [Plugins](/fr-FR/tools/plugin)

## Configuration rapide (débutant)

1. Installez le plugin Nextcloud Talk.
2. Sur votre serveur Nextcloud, créez un bot :

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Activez le bot dans les paramètres de la salle cible.
4. Configurez OpenClaw :
   - Config : `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Ou env : `NEXTCLOUD_TALK_BOT_SECRET` (compte par défaut uniquement)
5. Redémarrez la passerelle (ou terminez l'onboarding).

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

- Les bots ne peuvent pas initier de DM. L'utilisateur doit d'abord envoyer un message au bot.
- L'URL webhook doit être accessible par la Passerelle ; définissez `webhookPublicUrl` si derrière un proxy.
- Les uploads de médias ne sont pas supportés par l'API bot ; les médias sont envoyés comme URLs.
- La charge utile webhook ne distingue pas DM vs salles ; définissez `apiUser` + `apiPassword` pour activer les recherches de type de salle (sinon les DM sont traités comme salles).

## Contrôle d'accès (DM)

- Par défaut : `channels.nextcloud-talk.dmPolicy = "pairing"`. Les expéditeurs inconnus obtiennent un code d'appairage.
- Approuver via :
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- DM publics : `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` correspond uniquement aux IDs utilisateur Nextcloud ; les noms d'affichage sont ignorés.

## Salles (groupes)

- Par défaut : `channels.nextcloud-talk.groupPolicy = "allowlist"` (mention-gated).
- Allowlist salles avec `channels.nextcloud-talk.rooms` :

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

- Pour n'autoriser aucune salle, gardez l'allowlist vide ou définissez `channels.nextcloud-talk.groupPolicy="disabled"`.

## Capacités

| Fonctionnalité    | Statut        |
| ----------------- | ------------- |
| Messages directs  | Supporté      |
| Salles            | Supporté      |
| Fils              | Non supporté  |
| Médias            | URL seulement |
| Réactions         | Supporté      |
| Commandes natives | Non supporté  |

## Référence de configuration (Nextcloud Talk)

Configuration complète : [Configuration](/fr-FR/gateway/configuration)

Options du fournisseur :

- `channels.nextcloud-talk.enabled`: activer/désactiver démarrage canal.
- `channels.nextcloud-talk.baseUrl`: URL instance Nextcloud.
- `channels.nextcloud-talk.botSecret`: secret partagé bot.
- `channels.nextcloud-talk.botSecretFile`: chemin fichier secret.
- `channels.nextcloud-talk.apiUser`: utilisateur API pour recherches salle (détection DM).
- `channels.nextcloud-talk.apiPassword`: mot de passe API/app pour recherches salle.
- `channels.nextcloud-talk.apiPasswordFile`: chemin fichier mot de passe API.
- `channels.nextcloud-talk.webhookPort`: port écoute webhook (par défaut : 8788).
- `channels.nextcloud-talk.webhookHost`: hôte webhook (par défaut : 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: chemin webhook (par défaut : /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: URL webhook accessible extérieurement.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: allowlist DM (IDs utilisateur). `open` nécessite `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: allowlist groupe (IDs utilisateur).
- `channels.nextcloud-talk.rooms`: paramètres par salle et allowlist.
- `channels.nextcloud-talk.historyLimit`: limite historique groupe (0 désactive).
- `channels.nextcloud-talk.dmHistoryLimit`: limite historique DM (0 désactive).
- `channels.nextcloud-talk.dms`: remplacements par DM (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: taille morceau texte sortant (caractères).
- `channels.nextcloud-talk.chunkMode`: `length` (par défaut) ou `newline` pour diviser sur lignes vides (limites paragraphe) avant découpage longueur.
- `channels.nextcloud-talk.blockStreaming`: désactiver streaming bloc pour ce canal.
- `channels.nextcloud-talk.blockStreamingCoalesce`: ajustement coalescence streaming bloc.
- `channels.nextcloud-talk.mediaMaxMb`: limite média entrant (MB).

## Voir aussi

- [Plugins](/fr-FR/tools/plugin)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Appairage](/fr-FR/channels/pairing)
