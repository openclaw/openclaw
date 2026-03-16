---
summary: "Utilisez Anthropic Claude via des clés API ou setup-token dans OpenClaw"
read_when:
  - Vous voulez utiliser les modèles Anthropic dans OpenClaw
  - Vous voulez setup-token au lieu de clés API
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic construit la famille de modèles **Claude** et fournit un accès via une API.
Dans OpenClaw, vous pouvez vous authentifier avec une clé API ou un **setup-token**.

## Option A : Clé API Anthropic

**Meilleur pour :** accès API standard et facturation basée sur l'utilisation.
Créez votre clé API dans la Console Anthropic.

### Configuration CLI

```bash
openclaw onboard
# choisir : Clé API Anthropic

# ou non-interactif
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Extrait de config

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Mise en cache de prompt (API Anthropic)

OpenClaw supporte la fonctionnalité de mise en cache de prompt d'Anthropic. Cela est **API uniquement** ; l'auth par abonnement ne respecte pas les paramètres de cache.

### Configuration

Utilisez le paramètre `cacheRetention` dans votre config de modèle :

| Valeur  | Durée de Cache | Description                        |
| ------- | -------------- | ---------------------------------- |
| `none`  | Pas de cache   | Désactiver mise en cache de prompt |
| `short` | 5 minutes      | Par défaut pour auth Clé API       |
| `long`  | 1 heure        | Cache étendu (nécessite flag beta) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Valeurs par défaut

Lors de l'utilisation de l'authentification par Clé API Anthropic, OpenClaw applique automatiquement `cacheRetention: "short"` (cache 5 minutes) pour tous les modèles Anthropic. Vous pouvez remplacer cela en définissant explicitement `cacheRetention` dans votre config.

### Paramètre hérité

L'ancien paramètre `cacheControlTtl` est toujours supporté pour la compatibilité ascendante :

- `"5m"` correspond à `short`
- `"1h"` correspond à `long`

Nous recommandons de migrer vers le nouveau paramètre `cacheRetention`.

OpenClaw inclut le flag beta `extended-cache-ttl-2025-04-11` pour les requêtes API Anthropic ; gardez-le si vous remplacez les en-têtes de fournisseur (voir [/gateway/configuration](/fr-FR/gateway/configuration)).

## Option B : Claude setup-token

**Meilleur pour :** utiliser votre abonnement Claude.

### Où obtenir un setup-token

Les setup-tokens sont créés par le **Claude Code CLI**, pas la Console Anthropic. Vous pouvez l'exécuter sur **n'importe quelle machine** :

```bash
claude setup-token
```

Collez le token dans OpenClaw (wizard : **Token Anthropic (coller setup-token)**), ou exécutez-le sur l'hôte passerelle :

```bash
openclaw models auth setup-token --provider anthropic
```

Si vous avez généré le token sur une machine différente, collez-le :

```bash
openclaw models auth paste-token --provider anthropic
```

### Configuration CLI (setup-token)

```bash
# Coller un setup-token pendant l'onboarding
openclaw onboard --auth-choice setup-token
```

### Extrait de config (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notes

- Générez le setup-token avec `claude setup-token` et collez-le, ou exécutez `openclaw models auth setup-token` sur l'hôte passerelle.
- Si vous voyez "Échec du rafraîchissement du token OAuth …" sur un abonnement Claude, réauthentifiez avec un setup-token. Voir [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/fr-FR/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Les détails d'auth + règles de réutilisation sont dans [/concepts/oauth](/fr-FR/concepts/oauth).

## Dépannage

**Erreurs 401 / token soudainement invalide**

- L'auth par abonnement Claude peut expirer ou être révoquée. Réexécutez `claude setup-token` et collez-le dans l'**hôte passerelle**.
- Si le login CLI Claude vit sur une machine différente, utilisez `openclaw models auth paste-token --provider anthropic` sur l'hôte passerelle.

**Aucune clé API trouvée pour le fournisseur "anthropic"**

- L'auth est **par agent**. Les nouveaux agents n'héritent pas des clés de l'agent principal.
- Réexécutez l'onboarding pour cet agent, ou collez un setup-token / clé API sur l'hôte passerelle, puis vérifiez avec `openclaw models status`.

**Aucune information d'identification trouvée pour le profil `anthropic:default`**

- Exécutez `openclaw models status` pour voir quel profil auth est actif.
- Réexécutez l'onboarding, ou collez un setup-token / clé API pour ce profil.

**Aucun profil auth disponible (tous en cooldown/indisponible)**

- Vérifiez `openclaw models status --json` pour `auth.unusableProfiles`.
- Ajoutez un autre profil Anthropic ou attendez le cooldown.

Plus : [/gateway/troubleshooting](/fr-FR/gateway/troubleshooting) et [/help/faq](/fr-FR/help/faq).
