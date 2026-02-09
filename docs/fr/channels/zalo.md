---
summary: "Statut de prise en charge du bot Zalo, capacites et configuration"
read_when:
  - Travail sur les fonctionnalites Zalo ou les webhooks
title: "Zalo"
---

# Zalo (Bot API)

Statut : experimental. Messages prives uniquement ; groupes bientot disponibles selon la documentation Zalo.

## Plugin requis

Zalo est fourni sous forme de plugin et n’est pas inclus dans l’installation de base.

- Installer via la CLI : `openclaw plugins install @openclaw/zalo`
- Ou selectionner **Zalo** pendant la prise en main et confirmer l’invite d’installation
- Details : [Plugins](/plugin)

## Demarrage rapide (debutant)

1. Installer le plugin Zalo :
   - Depuis un checkout des sources : `openclaw plugins install ./extensions/zalo`
   - Depuis npm (si publie) : `openclaw plugins install @openclaw/zalo`
   - Ou choisir **Zalo** lors de la prise en main et confirmer l’invite d’installation
2. Definir le jeton :
   - Env: `ZALO_BOT_TOKEN=...`
   - Ou configuration : `channels.zalo.botToken: "..."`.
3. Redemarrer la Gateway (passerelle) (ou terminer la prise en main).
4. L'accès DM est appairage par défaut; approuve le code d'appairage au premier contact.

Configuration minimale :

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

## De quoi s’agit-il

Zalo est une application de messagerie axee sur le Vietnam ; son Bot API permet a la Gateway (passerelle) d’executer un bot pour des conversations 1:1.
C’est un bon choix pour le support ou les notifications lorsque vous souhaitez un routage deterministe vers Zalo.

- Un canal Zalo Bot API gere par la Gateway (passerelle).
- Routage deterministe : les reponses retournent vers Zalo ; le modele ne choisit jamais les canaux.
- Les Messages prives partagent la session principale de l’agent.
- Les groupes ne sont pas encore pris en charge (la documentation Zalo indique « coming soon »).

## Configuration (chemin rapide)

### 1. Creer un jeton de bot (Zalo Bot Platform)

1. Accedez a **https://bot.zaloplatforms.com** et connectez-vous.
2. Creez un nouveau bot et configurez ses parametres.
3. Copiez le jeton du bot (format : `12345689:abc-xyz`).

### 2) Configurer le jeton (env ou config)

Exemple :

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

Option env : `ZALO_BOT_TOKEN=...` (fonctionne uniquement pour le compte par defaut).

Prise en charge multi-comptes : utilisez `channels.zalo.accounts` avec des jetons par compte et, en option, `name`.

3. Redemarrez la Gateway (passerelle). Zalo demarre lorsqu’un jeton est resolu (env ou config).
4. L’acces aux Messages prives est en mode appairage par defaut. Approuvez le code lorsque le bot est contacte pour la premiere fois.

## Comment ça marche (comportement)

- Les messages entrants sont normalises dans l’enveloppe de canal partagee avec des espaces reserves pour les medias.
- Les reponses sont toujours routees vers la meme conversation Zalo.
- Scrutation longue par defaut ; mode webhook disponible avec `channels.zalo.webhookUrl`.

## Limites

- Les textes sortants sont decoupes en segments de 2000 caracteres (limite de l’API Zalo).
- Les telechargements/envois de medias sont plafonnes par `channels.zalo.mediaMaxMb` (valeur par defaut : 5).
- Le streaming est bloque par defaut, la limite de 2000 caracteres rendant le streaming moins utile.

## Contrôle d'accès (DMs)

### Accès DM

- Par defaut : `channels.zalo.dmPolicy = "pairing"`. Les expéditeurs inconnus recoivent un code d’appairage ; les messages sont ignores jusqu’a approbation (les codes expirent apres 1 heure).
- Approuver via :
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- L’appairage est l’echange de jeton par defaut. Details : [Pairing](/start/pairing)
- `channels.zalo.allowFrom` accepte des identifiants utilisateur numeriques (aucune recherche par nom d’utilisateur disponible).

## Scrutation longue vs webhook

- Par defaut : scrutation longue (aucune URL publique requise).
- Mode webhook : definir `channels.zalo.webhookUrl` et `channels.zalo.webhookSecret`.
  - Le secret du webhook doit comporter entre 8 et 256 caracteres.
  - L’URL du webhook doit utiliser HTTPS.
  - Zalo envoie les evenements avec l’en-tete `X-Bot-Api-Secret-Token` pour la verification.
  - Le serveur HTTP de la Gateway (passerelle) traite les requetes webhook a `channels.zalo.webhookPath` (par defaut, le chemin de l’URL du webhook).

**Remarque :** getUpdates (scrutation) et le webhook sont mutuellement exclusifs selon la documentation de l’API Zalo.

## Types de messages pris en charge

- **Messages texte** : prise en charge complete avec decoupage en segments de 2000 caracteres.
- **Messages image** : telechargement et traitement des images entrantes ; envoi d’images via `sendPhoto`.
- **Autocollants** : journalises mais pas entierement traites (pas de reponse de l’agent).
- **Types non pris en charge** : journalises (par ex., messages provenant d’utilisateurs proteges).

## Capacites

| Fonctionnalite                     | Statut                                                |
| ---------------------------------- | ----------------------------------------------------- |
| Messages directs                   | ✅ Pris en charge                                      |
| Groupes                            | ❌ Bientot disponible (docs Zalo)   |
| Medias (images) | ✅ Pris en charge                                      |
| Reactions                          | ❌ Non pris en charge                                  |
| Fil de discussion                  | ❌ Non pris en charge                                  |
| Sondages                           | ❌ Non pris en charge                                  |
| Commandes natives                  | ❌ Non pris en charge                                  |
| Streaming                          | ⚠️ Bloque (limite 2000 caracteres) |

## Cibles de livraison (CLI/cron)

- Utilisez un identifiant de conversation comme cible.
- Exemple : `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Problemes courants

**Le bot ne repond pas :**

- Verifiez que le jeton est valide : `openclaw channels status --probe`
- Verifiez que l’expediteur est approuve (appairage ou allowFrom)
- Consultez les journaux de la Gateway (passerelle) : `openclaw logs --follow`

**Le webhook ne recoit pas d’evenements :**

- Assurez-vous que l’URL du webhook utilise HTTPS
- Verifiez que le jeton secret comporte 8 a 256 caracteres
- Confirmez que le point de terminaison HTTP de la Gateway (passerelle) est accessible sur le chemin configure
- Verifiez que la scrutation getUpdates n’est pas en cours (ils sont mutuellement exclusifs)

## Reference de configuration (Zalo)

Configuration complete : [Configuration](/gateway/configuration)

Options du fournisseur :

- `channels.zalo.enabled` : activer/desactiver le demarrage du canal.
- `channels.zalo.botToken` : jeton de bot depuis Zalo Bot Platform.
- `channels.zalo.tokenFile` : lire le jeton depuis un chemin de fichier.
- `channels.zalo.dmPolicy` : `pairing | allowlist | open | disabled` (par defaut : appairage).
- `channels.zalo.allowFrom` : liste d’autorisation des Messages prives (identifiants utilisateur). `open` requiert `"*"`. L’assistant demandera des identifiants numeriques.
- `channels.zalo.mediaMaxMb` : plafond des medias entrants/sortants (Mo, defaut : 5).
- `channels.zalo.webhookUrl` : activer le mode webhook (HTTPS requis).
- `channels.zalo.webhookSecret` : secret du webhook (8–256 caracteres).
- `channels.zalo.webhookPath` : chemin du webhook sur le serveur HTTP de la Gateway (passerelle).
- `channels.zalo.proxy` : URL de proxy pour les requetes API.

Options multi-comptes :

- `channels.zalo.accounts.<id>.botToken` : jeton par compte.
- `channels.zalo.accounts.<id>.tokenFile` : fichier de jeton par compte.
- `channels.zalo.accounts.<id>.name` : nom d’affichage.
- `channels.zalo.accounts.<id>.enabled` : activer/desactiver le compte.
- `channels.zalo.accounts.<id>.dmPolicy` : politique de Messages prives par compte.
- `channels.zalo.accounts.<id>.allowFrom` : liste d’autorisation par compte.
- `channels.zalo.accounts.<id>.webhookUrl` : URL de webhook par compte.
- `channels.zalo.accounts.<id>.webhookSecret` : secret de webhook par compte.
- `channels.zalo.accounts.<id>.webhookPath` : chemin de webhook par compte.
- `channels.zalo.accounts.<id>.proxy` : URL de proxy par compte.
