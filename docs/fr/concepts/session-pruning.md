---
summary: "Élagage de session : rognage des résultats d’outils pour réduire l’encombrement du contexte"
read_when:
  - Vous souhaitez réduire la croissance du contexte LLM due aux sorties d’outils
  - Vous ajustez agents.defaults.contextPruning
---

# Élagage de session

L’élagage de session rogne les **anciens résultats d’outils** du contexte en mémoire juste avant chaque appel LLM. Il **ne** réécrit **pas** l’historique de session sur disque (`*.jsonl`).

## Quand il s’exécute

- Lorsque `mode: "cache-ttl"` est activé et que le dernier appel Anthropic de la session est plus ancien que `ttl`.
- N’affecte que les messages envoyés au modèle pour cette requête.
- Actif uniquement pour les appels à l’API Anthropic (et les modèles Anthropic via OpenRouter).
- Pour de meilleurs résultats, faites correspondre `ttl` à votre `cacheControlTtl` du modèle.
- Après un élagage, la fenêtre TTL est réinitialisée afin que les requêtes suivantes conservent le cache jusqu’à l’expiration de `ttl` à nouveau.

## Valeurs par défaut intelligentes (Anthropic)

- Profils **OAuth ou setup-token** : activer l’élagage `cache-ttl` et définir le heartbeat sur `1h`.
- Profils **clé API** : activer l’élagage `cache-ttl`, définir le heartbeat sur `30m`, et définir par défaut `cacheControlTtl` à `1h` sur les modèles Anthropic.
- Si vous définissez explicitement l’une de ces valeurs, OpenClaw **ne** les remplace **pas**.

## Ce que cela améliore (coût + comportement du cache)

- **Pourquoi élaguer :** la mise en cache des prompts Anthropic ne s’applique qu’à l’intérieur du TTL. Si une session reste inactive au-delà du TTL, la requête suivante remet en cache l’intégralité du prompt, sauf si vous le rognez d’abord.
- **Ce qui devient moins cher :** l’élagage réduit la taille **cacheWrite** pour cette première requête après l’expiration du TTL.
- **Pourquoi la réinitialisation du TTL est importante :** une fois l’élagage exécuté, la fenêtre de cache est réinitialisée ; les requêtes suivantes peuvent donc réutiliser le prompt fraîchement mis en cache au lieu de remettre en cache tout l’historique.
- **Ce que cela ne fait pas :** l’élagage n’ajoute pas de tokens ni ne « double » les coûts ; il modifie uniquement ce qui est mis en cache lors de cette première requête post‑TTL.

## Ce qui peut être élagué

- Uniquement les messages `toolResult`.
- Les messages utilisateur + assistant ne sont **jamais** modifiés.
- Les `keepLastAssistants` derniers messages de l’assistant sont protégés ; les résultats d’outils au‑delà de ce seuil ne sont pas élagués.
- S’il n’y a pas suffisamment de messages de l’assistant pour établir le seuil, l’élagage est ignoré.
- Les résultats d’outils contenant des **blocs d’images** sont ignorés (jamais rognés/vidés).

## Estimation de la fenêtre de contexte

L’élagage utilise une estimation de la fenêtre de contexte (caractères ≈ tokens × 4). La fenêtre de base est résolue dans cet ordre :

1. Remplacement `models.providers.*.models[].contextWindow`.
2. Définition du modèle `contextWindow` (depuis le registre des modèles).
3. Valeur par défaut de `200000` tokens.

Si `agents.defaults.contextTokens` est défini, il est traité comme un plafond (min) de la fenêtre résolue.

## Mode

### cache-ttl

- L’élagage ne s’exécute que si le dernier appel Anthropic est plus ancien que `ttl` (par défaut `5m`).
- Lorsqu’il s’exécute : même comportement de rognage léger (soft‑trim) + effacement dur (hard‑clear) qu’auparavant.

## Rognage léger vs effacement dur

- **Rognage léger (soft‑trim)** : uniquement pour les résultats d’outils surdimensionnés.
  - Conserve le début + la fin, insère `...`, et ajoute une note avec la taille d’origine.
  - Ignore les résultats avec des blocs d’images.
- **Effacement dur (hard‑clear)** : remplace l’intégralité du résultat d’outil par `hardClear.placeholder`.

## Sélection des outils

- `tools.allow` / `tools.deny` prennent en charge les jokers `*`.
- Refuser la victoire.
- La correspondance est insensible à la casse.
- Liste d’autorisation vide => tous les outils sont autorisés.

## Interaction avec d’autres limites

- Les outils intégrés tronquent déjà leur propre sortie ; l’élagage de session est une couche supplémentaire qui empêche les discussions longues d’accumuler trop de sorties d’outils dans le contexte du modèle.
- La compaction est distincte : la compaction résume et persiste, l’élagage est transitoire par requête. Voir [/concepts/compaction](/concepts/compaction).

## Valeurs par défaut (lorsqu’activé)

- `ttl` : `"5m"`
- `keepLastAssistants` : `3`
- `softTrimRatio` : `0.3`
- `hardClearRatio` : `0.5`
- `minPrunableToolChars` : `50000`
- `softTrim` : `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear` : `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Exemples

Par défaut (désactivé) :

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Activer l’élagage sensible au TTL :

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Restreindre l’élagage à des outils spécifiques :

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Voir la référence de configuration : [Configuration de la Gateway (passerelle)](/gateway/configuration)
