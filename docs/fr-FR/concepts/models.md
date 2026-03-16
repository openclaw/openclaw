---
summary: "CLI Modèles : lister, définir, alias, fallbacks, scan, statut"
read_when:
  - Ajout ou modification CLI modèles (models list/set/scan/aliases/fallbacks)
  - Changement comportement fallback modèle ou UX sélection
  - Mise à jour sondes scan modèle (outils/images)
title: "CLI Modèles"
---

# CLI Modèles

Voir [/fr-FR/concepts/model-failover](/fr-FR/concepts/model-failover) pour rotation profil auth, cooldowns et comment cela interagit avec les fallbacks.
Aperçu rapide fournisseur + exemples : [/fr-FR/concepts/model-providers](/fr-FR/concepts/model-providers).

## Comment fonctionne la sélection de modèle

OpenClaw sélectionne les modèles dans cet ordre :

1. Modèle **primaire** (`agents.defaults.model.primary` ou `agents.defaults.model`).
2. **Fallbacks** dans `agents.defaults.model.fallbacks` (dans l'ordre).
3. **Failover auth fournisseur** se produit à l'intérieur d'un fournisseur avant de passer au modèle suivant.

Lié :

- `agents.defaults.models` est l'allowlist/catalogue de modèles qu'OpenClaw peut utiliser (plus alias).
- `agents.defaults.imageModel` est utilisé **uniquement quand** le modèle primaire ne peut pas accepter d'images.
- Les valeurs par défaut par agent peuvent remplacer `agents.defaults.model` via `agents.list[].model` plus bindings (voir [/fr-FR/concepts/multi-agent](/fr-FR/concepts/multi-agent)).

## Choix de modèles rapides (anecdotique)

- **GLM** : un peu meilleur pour codage/appel d'outil.
- **MiniMax** : meilleur pour écriture et vibes.

## Assistant de configuration (recommandé)

Si vous ne voulez pas éditer manuellement la config, exécutez l'assistant d'onboarding :

```bash
openclaw onboard
```

Il peut configurer modèle + auth pour fournisseurs courants, incluant **abonnement OpenAI Code (Codex)** (OAuth) et **Anthropic** (clé API recommandée ; `claude setup-token` également supporté).

## Clés de config (aperçu)

- `agents.defaults.model.primary` et `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` et `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (allowlist + alias + params fournisseur)
- `models.providers` (fournisseurs personnalisés écrits dans `models.json`)

Les références de modèle sont normalisées en minuscules. Les alias de fournisseur comme `z.ai/*` se normalisent en `zai/*`.

Les exemples de configuration de fournisseur (incluant OpenCode Zen) vivent dans [/fr-FR/gateway/configuration](/fr-FR/gateway/configuration#opencode-zen-multi-model-proxy).

## "Le modèle n'est pas autorisé" (et pourquoi les réponses s'arrêtent)

Si `agents.defaults.models` est défini, il devient l'**allowlist** pour `/model` et pour les remplacements de session. Quand un utilisateur sélectionne un modèle qui n'est pas dans cette allowlist, OpenClaw retourne :

```
Le modèle "provider/model" n'est pas autorisé. Utilisez /model pour lister les modèles disponibles.
```

Cela se produit **avant** qu'une réponse normale soit générée, donc le message peut sembler comme s'il "n'a pas répondu." La correction est soit :

- Ajouter le modèle à `agents.defaults.models`, ou
- Effacer l'allowlist (supprimer `agents.defaults.models`), ou
- Choisir un modèle depuis `/model list`.

Exemple de config allowlist :

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Changer de modèles en chat (`/model`)

Vous pouvez changer de modèles pour la session actuelle sans redémarrer :

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model anthropic/claude-opus-4-6
```

## Commandes CLI

### Lister les modèles disponibles

```bash
openclaw models list
openclaw models list --json
```

### Définir le modèle primaire

```bash
openclaw models set anthropic/claude-sonnet-4-5
```

### Ajouter des fallbacks

```bash
openclaw models fallbacks add openai/gpt-4o-mini
openclaw models fallbacks remove openai/gpt-4o-mini
openclaw models fallbacks list
```

### Scanner les capacités de modèle

```bash
openclaw models scan
openclaw models scan --provider anthropic
openclaw models scan --model anthropic/claude-sonnet-4-5
```

### Voir les alias

```bash
openclaw models aliases
```

## Voir aussi

- [Fournisseurs de Modèles](/fr-FR/concepts/model-providers)
- [Failover de Modèle](/fr-FR/concepts/model-failover)
- [Configuration](/fr-FR/gateway/configuration)
