---
summary: "Statut support bot Zalo, capacités et configuration"
read_when:
  - Travail sur fonctionnalités Zalo ou webhooks
title: "Zalo"
---

# Zalo (Bot API)

Statut : expérimental. Messages directs uniquement ; groupes à venir bientôt selon docs Zalo.

## Plugin requis

Zalo est fourni comme plugin et n'est pas inclus avec l'installation de base.

- Installation via CLI : `openclaw plugins install @openclaw/zalo`
- Ou sélectionnez **Zalo** pendant l'onboarding et confirmez l'invite d'installation
- Détails : [Plugins](/fr-FR/tools/plugin)

## Configuration rapide (débutant)

1. Installez le plugin Zalo :
   - Depuis un checkout source : `openclaw plugins install ./extensions/zalo`
   - Depuis npm (si publié) : `openclaw plugins install @openclaw/zalo`
   - Ou choisissez **Zalo** dans l'onboarding et confirmez l'invite d'installation
2. Définissez le jeton :
   - Env : `ZALO_BOT_TOKEN=...`
   - Ou config : `channels.zalo.botToken: "..."`.
3. Redémarrez la passerelle (ou terminez l'onboarding).
4. L'accès DM est en appairage par défaut ; approuvez le code d'appairage au premier contact.

Configuration minimale :

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## Ce que c'est

Zalo est une app de messagerie ciblant le Vietnam ; son Bot API permet à la Passerelle d'exécuter un bot pour les conversations 1:1. C'est adapté pour le support ou les notifications où vous voulez un routage déterministe vers Zalo.

- Un canal Zalo Bot API appartenant à la Passerelle.
- Routage déterministe : les réponses retournent vers Zalo ; le modèle ne choisit jamais les canaux.
- Les DM partagent la session principale de l'agent.
- Les groupes ne sont pas encore supportés (les docs Zalo indiquent "à venir bientôt").

## Configuration (chemin rapide)

### 1) Créer un jeton bot (Plateforme Bot Zalo)

1. Allez sur [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) et connectez-vous.
2. Créez un nouveau bot et configurez ses paramètres.
3. Copiez le jeton bot (format : `12345689:abc-xyz`).

### 2) Configurer le jeton (env ou config)

Exemple :

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Option env : `ZALO_BOT_TOKEN=...` (fonctionne uniquement pour le compte par défaut).

Support multi-comptes : utilisez `channels.zalo.accounts` avec jetons par compte et `name` optionnel.

3. Redémarrez la passerelle. Zalo démarre quand un jeton est résolu (env ou config).
4. L'accès DM est par défaut en appairage. Approuvez le code quand le bot est contacté pour la première fois.

## Comment ça fonctionne (comportement)

- Les messages entrants sont normalisés dans l'enveloppe canal partagée avec des placeholders média.
- Les réponses routent toujours vers le même chat Zalo.
- Long-polling par défaut ; mode webhook disponible avec `channels.zalo.webhookUrl`.

## Limites

- Le texte sortant est découpé à 2000 caractères (limite API Zalo).
- Les téléchargements/uploads média sont limités par `channels.zalo.mediaMaxMb` (par défaut 5).
- Le streaming est bloqué par défaut en raison de la limite de 2000 caractères rendant le streaming moins utile.

## Contrôle d'accès (DM)

### Accès DM

- Par défaut : `channels.zalo.dmPolicy = "pairing"`. Les expéditeurs inconnus reçoivent un code d'appairage ; les messages sont ignorés jusqu'à approbation (les codes expirent après 1 heure).
- Approuver via :
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- L'appairage est l'échange de jeton par défaut. Détails : [Appairage](/fr-FR/channels/pairing)
- `channels.zalo.allowFrom` accepte les IDs utilisateur numériques (pas de recherche de nom d'utilisateur disponible).

## Long-polling vs webhook

- Par défaut : long-polling (aucune URL publique requise).
- Mode webhook : définissez `channels.zalo.webhookUrl` et `channels.zalo.webhookSecret`.
  - Le secret webhook doit faire 8-256 caractères.
  - L'URL webhook doit utiliser HTTPS.
  - Zalo envoie des événements avec le header `X-Bot-Api-Secret-Token` pour vérification.
  - La passerelle HTTP gère les requêtes webhook à `channels.zalo.webhookPath` (par défaut au chemin URL webhook).

**Note :** getUpdates (polling) et webhook sont mutuellement exclusifs selon les docs API Zalo.

## Types de messages supportés

- **Messages texte** : Support complet avec découpage 2000 caractères.
- **Messages image** : Télécharger et traiter les images entrantes ; envoyer des images via `sendPhoto`.
- **Stickers** : Enregistrés mais pas entièrement traités (pas de réponse agent).
- **Types non supportés** : Enregistrés (par ex., messages d'utilisateurs protégés).

## Capacités

| Fonctionnalité    | Statut                               |
| ----------------- | ------------------------------------ |
| Messages directs  | ✅ Supporté                          |
| Groupes           | ❌ À venir bientôt (selon docs Zalo) |
| Médias (images)   | ✅ Supporté                          |
| Réactions         | ❌ Non supporté                      |
| Fils              | ❌ Non supporté                      |
| Sondages          | ❌ Non supporté                      |
| Commandes natives | ❌ Non supporté                      |
| Streaming         | ⚠️ Bloqué (limite 2000 caractères)   |

## Cibles de livraison (CLI/cron)

- Utilisez un id de chat comme cible.
- Exemple : `openclaw message send --channel zalo --target 123456789 --message "salut"`.

## Dépannage

**Le bot ne répond pas :**

- Vérifiez que le jeton est valide : `openclaw channels status --probe`
- Vérifiez que l'expéditeur est approuvé (appairage ou allowFrom)
- Vérifiez les journaux passerelle : `openclaw logs --follow`

**Le webhook ne reçoit pas d'événements :**

- Assurez-vous que l'URL webhook utilise HTTPS
- Vérifiez que le jeton secret fait 8-256 caractères
- Confirmez que le point de terminaison HTTP passerelle est accessible sur le chemin configuré
- Vérifiez que le polling getUpdates n'est pas en cours d'exécution (ils sont mutuellement exclusifs)

## Référence de configuration (Zalo)

Configuration complète : [Configuration](/fr-FR/gateway/configuration)

Options du fournisseur :

- `channels.zalo.enabled`: activer/désactiver démarrage canal.
- `channels.zalo.botToken`: jeton bot depuis Plateforme Bot Zalo.
- `channels.zalo.tokenFile`: lire jeton depuis chemin fichier.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (par défaut : pairing).
- `channels.zalo.allowFrom`: allowlist DM (IDs utilisateur). `open` nécessite `"*"`. L'assistant demandera des IDs numériques.
- `channels.zalo.mediaMaxMb`: limite média entrant/sortant (MB, par défaut 5).
- `channels.zalo.webhookUrl`: activer mode webhook (HTTPS requis).
- `channels.zalo.webhookSecret`: secret webhook (8-256 caractères).
- `channels.zalo.webhookPath`: chemin webhook sur serveur HTTP passerelle.
- `channels.zalo.proxy`: URL proxy pour requêtes API.

Options multi-comptes :

- `channels.zalo.accounts.<id>.botToken`: jeton par compte.
- `channels.zalo.accounts.<id>.tokenFile`: fichier jeton par compte.
- `channels.zalo.accounts.<id>.name`: nom d'affichage.
- `channels.zalo.accounts.<id>.enabled`: activer/désactiver compte.
- `channels.zalo.accounts.<id>.dmPolicy`: politique DM par compte.
- `channels.zalo.accounts.<id>.allowFrom`: allowlist par compte.
- `channels.zalo.accounts.<id>.webhookUrl`: URL webhook par compte.
- `channels.zalo.accounts.<id>.webhookSecret`: secret webhook par compte.
- `channels.zalo.accounts.<id>.webhookPath`: chemin webhook par compte.
- `channels.zalo.accounts.<id>.proxy`: URL proxy par compte.

## Voir aussi

- [Plugins](/fr-FR/tools/plugin)
- [Configuration de la Passerelle](/fr-FR/gateway/configuration)
- [Appairage](/fr-FR/channels/pairing)
