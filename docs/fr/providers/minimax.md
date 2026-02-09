---
summary: "Utiliser MiniMax M2.1 dans OpenClaw"
read_when:
  - Vous souhaitez des modèles MiniMax dans OpenClaw
  - Vous avez besoin de conseils de configuration MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax est une entreprise d’IA qui développe la famille de modèles **M2/M2.1**. La version actuelle axée sur le code est **MiniMax M2.1** (23 décembre 2025), conçue pour des tâches complexes du monde réel.

Source : [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## Aperçu du modèle (M2.1)

MiniMax met en avant les améliorations suivantes dans M2.1 :

- **Codage multilingue** plus performant (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Meilleur **développement web/app** et qualité esthétique des sorties (y compris mobile natif).
- Gestion améliorée des **instructions composites** pour des workflows de type bureautique, s’appuyant sur une réflexion entrelacée et une exécution de contraintes intégrée.
- **Réponses plus concises** avec une consommation de tokens plus faible et des boucles d’itération plus rapides.
- Meilleure compatibilité avec les **frameworks outil/agent** et la gestion du contexte (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Sorties de **dialogue et de rédaction technique** de meilleure qualité.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Vitesse :** Lightning est la variante « rapide » dans la documentation tarifaire de MiniMax.
- **Coût :** Les tarifs indiquent le même coût d’entrée, mais Lightning a un coût de sortie plus élevé.
- **Routage du plan Coding :** Le back-end Lightning n’est pas directement disponible sur le plan Coding de MiniMax. MiniMax redirige automatiquement la plupart des requêtes vers Lightning, mais bascule vers le back-end M2.1 standard lors des pics de trafic.

## Choisir une configuration

### MiniMax OAuth (plan Coding) — recommandé

**Idéal pour :** configuration rapide avec le plan Coding MiniMax via OAuth, sans clé API requise.

Activez le plugin OAuth fourni et authentifiez-vous :

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Vous serez invité à sélectionner un endpoint :

- **Global** - Utilisateurs internationaux (`api.minimax.io`)
- **CN** - Utilisateurs en Chine (`api.minimaxi.com`)

Voir le [README du plugin OAuth MiniMax](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) pour plus de détails.

### MiniMax M2.1 (clé API)

**Idéal pour :** MiniMax hébergé avec une API compatible Anthropic.

Configurer via la CLI :

- Exécutez `openclaw configure`
- Sélectionnez **Model/auth**
- Choisissez **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 comme solution de secours (Opus principal)

**Idéal pour :** conserver Opus 4.6 comme principal, avec bascule vers MiniMax M2.1 en cas d’échec.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Optionnel : local via LM Studio (manuel)

**Idéal pour :** inférence locale avec LM Studio.
Nous avons observé d’excellents résultats avec MiniMax M2.1 sur du matériel puissant (par ex. un ordinateur de bureau/serveur) en utilisant le serveur local de LM Studio.

Configurer manuellement via `openclaw.json` :

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Configurer via `openclaw configure`

Utilisez l’assistant de configuration interactif pour définir MiniMax sans modifier de JSON :

1. Exécutez `openclaw configure`.
2. Sélectionnez **Model/auth**.
3. Choisissez **MiniMax M2.1**.
4. Sélectionnez votre modèle par défaut lorsqu’on vous le demande.

## Options de configuration

- `models.providers.minimax.baseUrl` : privilégiez `https://api.minimax.io/anthropic` (compatible Anthropic) ; `https://api.minimax.io/v1` est optionnel pour des payloads compatibles OpenAI.
- `models.providers.minimax.api` : privilégiez `anthropic-messages` ; `openai-completions` est optionnel pour des payloads compatibles OpenAI.
- `models.providers.minimax.apiKey` : clé API MiniMax (`MINIMAX_API_KEY`).
- `models.providers.minimax.models` : définir `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models` : créer des alias pour les modèles que vous souhaitez dans la liste d’autorisation.
- `models.mode` : conservez `merge` si vous souhaitez ajouter MiniMax aux modèles intégrés.

## Notes

- Les références de modèles sont `minimax/<model>`.
- API d’utilisation du plan Coding : `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (nécessite une clé de plan Coding).
- Mettez à jour les valeurs de tarification dans `models.json` si vous avez besoin d’un suivi précis des coûts.
- Lien de parrainage pour le plan Coding MiniMax (10 % de réduction) : https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link
- Voir [/concepts/model-providers](/concepts/model-providers) pour les règles des fournisseurs.
- Utilisez `openclaw models list` et `openclaw models set minimax/MiniMax-M2.1` pour changer.

## Problemes courants

### « Unknown model: minimax/MiniMax-M2.1 »

Cela signifie généralement que le **fournisseur MiniMax n’est pas configuré** (aucune entrée de fournisseur et aucun profil d’authentification MiniMax/clé d’environnement trouvé). Un correctif pour cette détection est prévu dans **2026.1.12** (non publié au moment de la rédaction). Pour corriger :

- Passez à **2026.1.12** (ou exécutez depuis la source `main`), puis redémarrez la Gateway (passerelle).
- Exécutez `openclaw configure` et sélectionnez **MiniMax M2.1**, ou
- Ajoutez manuellement le bloc `models.providers.minimax`, ou
- Définissez `MINIMAX_API_KEY` (ou un profil d’authentification MiniMax) afin que le fournisseur puisse être injecté.

Assurez-vous que l’identifiant du modèle est **sensible à la casse** :

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Puis vérifiez à nouveau avec :

```bash
openclaw models list
```
