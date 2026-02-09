---
summary: "Utiliser Anthropic Claude via des cles API ou un setup-token dans OpenClaw"
read_when:
  - Vous souhaitez utiliser des modeles Anthropic dans OpenClaw
  - Vous souhaitez utiliser un setup-token au lieu de cles API
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic developpe la famille de modeles **Claude** et fournit un acces via une API.
Dans OpenClaw, vous pouvez vous authentifier avec une cle API ou un **setup-token**.

## Option A : Cle API Anthropic

**Ideal pour :** l’acces API standard et la facturation a l’usage.
Creez votre cle API dans la console Anthropic.

### Configuration via la CLI

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Extrait de configuration

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Mise en cache des prompts (API Anthropic)

OpenClaw prend en charge la fonctionnalite de mise en cache des prompts d’Anthropic. C’est **uniquement via l’API** ; l’authentification par abonnement ne respecte pas les parametres de cache.

### Configuration

Utilisez le parametre `cacheRetention` dans la configuration de votre modele :

| Valeur  | Duree du cache | Description                                                 |
| ------- | -------------- | ----------------------------------------------------------- |
| `none`  | Pas de cache   | Desactiver la mise en cache des prompts                     |
| `short` | 5 minutes      | Valeur par defaut pour l’authentification par cle API       |
| `long`  | 1 heure        | Cache etendu (necessite le drapeau beta) |

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

Lors de l’utilisation de l’authentification par cle API Anthropic, OpenClaw applique automatiquement `cacheRetention: "short"` (cache de 5 minutes) a tous les modeles Anthropic. Vous pouvez remplacer ce comportement en definissant explicitement `cacheRetention` dans votre configuration.

### Parametre historique

L’ancien parametre `cacheControlTtl` est toujours pris en charge pour assurer la retrocompatibilite :

- `"5m"` correspond a `short`
- `"1h"` correspond a `long`

Nous recommandons de migrer vers le nouveau parametre `cacheRetention`.

OpenClaw inclut le drapeau beta `extended-cache-ttl-2025-04-11` pour les requetes API Anthropic ;
conservez-le si vous surchargez les en-tetes du fournisseur (voir [/gateway/configuration](/gateway/configuration)).

## Option B : Setup-token Claude

**Ideal pour :** utiliser votre abonnement Claude.

### Ou obtenir un setup-token

Les setup-tokens sont crees par la **Claude Code CLI**, et non par la console Anthropic. Vous pouvez l’executer sur **n’importe quelle machine** :

```bash
claude setup-token
```

Collez le token dans OpenClaw (assistant : **Anthropic token (coller le setup-token)**), ou executez-le sur l’hote de la passerelle :

```bash
openclaw models auth setup-token --provider anthropic
```

Si vous avez genere le token sur une autre machine, collez-le :

```bash
openclaw models auth paste-token --provider anthropic
```

### Configuration via la CLI

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Configuration du snippet (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notes

- Generez le setup-token avec `claude setup-token` et collez-le, ou executez `openclaw models auth setup-token` sur l’hote de la passerelle.
- Si vous voyez « OAuth token refresh failed … » avec un abonnement Claude, re-authentifiez-vous avec un setup-token. Voir [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Les details d’authentification et les regles de reutilisation sont decrits dans [/concepts/oauth](/concepts/oauth).

## Problemes courants

**Erreurs 401 / token soudainement invalide**

- L’authentification par abonnement Claude peut expirer ou etre revoquee. Re-executez `claude setup-token`
  et collez-le sur l’**hote de la passerelle**.
- Si la connexion via la CLI Claude se trouve sur une autre machine, utilisez
  `openclaw models auth paste-token --provider anthropic` sur l’hote de la passerelle.

**Aucune cle API trouvee pour le fournisseur « anthropic »**

- L’authentification est **par agent**. Les nouveaux agents n’heritent pas des cles de l’agent principal.
- Relancez la prise en main pour cet agent, ou collez un setup-token / une cle API sur l’hote de la passerelle, puis verifiez avec `openclaw models status`.

**Aucun identifiant trouve pour le profil `anthropic:default`**

- Executez `openclaw models status` pour voir quel profil d’authentification est actif.
- Relancez la prise en main, ou collez un setup-token / une cle API pour ce profil.

**Aucun profil d’authentification disponible (tous en cooldown/indisponibles)**

- Verifiez `openclaw models status --json` pour `auth.unusableProfiles`.
- Ajoutez un autre profil Anthropic ou attendez la fin du cooldown.

Plus d’informations : [/gateway/troubleshooting](/gateway/troubleshooting) et [/help/faq](/help/faq).
