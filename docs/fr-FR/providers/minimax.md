---
summary: "Utilisez MiniMax M2.1 dans OpenClaw"
read_when:
  - Vous voulez des modèles MiniMax dans OpenClaw
  - Vous avez besoin de conseils de configuration MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax est une entreprise IA qui construit la famille de modèles **M2/M2.1**. La version actuelle axée sur le codage est **MiniMax M2.1** (23 décembre 2025), construite pour des tâches complexes du monde réel.

Source : [Note de version MiniMax M2.1](https://www.minimax.io/news/minimax-m21)

## Aperçu du modèle (M2.1)

MiniMax met en avant ces améliorations dans M2.1 :

- **Codage multi-langage** plus fort (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Meilleur **développement web/app** et qualité de sortie esthétique (incluant mobile natif).
- Gestion améliorée **d'instruction composite** pour flux de travail de type bureau, s'appuyant sur la pensée entrelacée et l'exécution de contraintes intégrées.
- **Réponses plus concises** avec utilisation de token plus basse et boucles d'itération plus rapides.
- Compatibilité **framework outil/agent** plus forte et gestion de contexte (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Sorties de **dialogue et écriture technique** de meilleure qualité.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Vitesse :** Lightning est la variante "rapide" dans les docs de tarification MiniMax.
- **Coût :** La tarification montre le même coût d'entrée, mais Lightning a un coût de sortie plus élevé.
- **Routage plan codage :** Le backend Lightning n'est pas directement disponible sur le plan codage MiniMax. MiniMax route automatiquement la plupart des requêtes vers Lightning, mais se replie sur le backend M2.1 régulier pendant les pics de trafic.

## Choisir une configuration

### OAuth MiniMax (Plan Codage) — recommandé

**Meilleur pour :** configuration rapide avec Plan Codage MiniMax via OAuth, aucune clé API requise.

Activez le plugin OAuth intégré et authentifiez :

```bash
openclaw plugins enable minimax-portal-auth  # ignorer si déjà chargé.
openclaw gateway restart  # redémarrer si la passerelle s'exécute déjà
openclaw onboard --auth-choice minimax-portal
```

Vous serez invité à sélectionner un point de terminaison :

- **Global** - Utilisateurs internationaux (`api.minimax.io`)
- **CN** - Utilisateurs en Chine (`api.minimaxi.com`)

Voir [README plugin OAuth MiniMax](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) pour les détails.

### MiniMax M2.1 (clé API)

**Meilleur pour :** MiniMax hébergé avec API compatible Anthropic.

Configurez via CLI :

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

### MiniMax M2.1 comme repli (Opus principal)

**Meilleur pour :** garder Opus 4.6 comme principal, basculer vers MiniMax M2.1.

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

### Optionnel : Local via LM Studio (manuel)

**Meilleur pour :** inférence locale avec LM Studio.
Nous avons vu de bons résultats avec MiniMax M2.1 sur du matériel puissant (par ex. un bureau/serveur) utilisant le serveur local de LM Studio.

Configurez manuellement via `openclaw.json` :

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

Utilisez le wizard de config interactif pour définir MiniMax sans éditer JSON :

1. Exécutez `openclaw configure`.
2. Sélectionnez **Model/auth**.
3. Choisissez **MiniMax M2.1**.
4. Choisissez votre modèle par défaut lorsque demandé.

## Options de configuration

- `models.providers.minimax.baseUrl` : préférez `https://api.minimax.io/anthropic` (compatible Anthropic) ; `https://api.minimax.io/v1` est optionnel pour charges utiles compatibles OpenAI.
- `models.providers.minimax.api` : préférez `anthropic-messages` ; `openai-completions` est optionnel pour charges utiles compatibles OpenAI.
- `models.providers.minimax.apiKey` : clé API MiniMax (`MINIMAX_API_KEY`).
- `models.providers.minimax.models` : définir `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models` : alias des modèles que vous voulez dans l'allowlist.
- `models.mode` : garder `merge` si vous voulez ajouter MiniMax aux intégrés.

## Notes

- Les références de modèle sont `minimax/<model>`.
- API d'utilisation Plan Codage : `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (nécessite une clé de plan codage).
- Mettez à jour les valeurs de tarification dans `models.json` si vous avez besoin d'un suivi exact des coûts.
- Lien de parrainage pour Plan Codage MiniMax (10% de réduction) : [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Voir [/concepts/model-providers](/fr-FR/concepts/model-providers) pour les règles de fournisseur.
- Utilisez `openclaw models list` et `openclaw models set minimax/MiniMax-M2.1` pour basculer.

## Dépannage

### "Modèle inconnu : minimax/MiniMax-M2.1"

Cela signifie généralement que le **fournisseur MiniMax n'est pas configuré** (pas d'entrée de fournisseur et pas de profil auth/clé env MiniMax trouvé). Un correctif pour cette détection est dans **2026.1.12** (non publié au moment de l'écriture). Corrigez en :

- Mettant à niveau vers **2026.1.12** (ou exécutez depuis la source `main`), puis redémarrez la passerelle.
- Exécutant `openclaw configure` et sélectionnant **MiniMax M2.1**, ou
- Ajoutant le bloc `models.providers.minimax` manuellement, ou
- Définissant `MINIMAX_API_KEY` (ou un profil auth MiniMax) pour que le fournisseur puisse être injecté.

Assurez-vous que l'id du modèle est **sensible à la casse** :

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Puis revérifiez avec :

```bash
openclaw models list
```
