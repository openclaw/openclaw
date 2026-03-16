---
title: "Élagage de session"
summary: "Élagage de session : réduction de résultat d'outil pour réduire le gonflement de contexte"
read_when:
  - Vous voulez réduire la croissance de contexte LLM des sorties d'outils
  - Vous ajustez agents.defaults.contextPruning
---

# Élagage de session

L'élagage de session rogne les **vieux résultats d'outils** du contexte en mémoire juste avant chaque appel LLM. Il ne **réécrit pas** l'historique de session sur disque (`*.jsonl`).

## Quand il s'exécute

- Quand `mode: "cache-ttl"` est activé et que le dernier appel Anthropic pour la session est plus ancien que `ttl`.
- N'affecte que les messages envoyés au modèle pour cette requête.
- Uniquement actif pour les appels API Anthropic (et les modèles Anthropic OpenRouter).
- Pour de meilleurs résultats, faites correspondre `ttl` à votre modèle `cacheControlTtl`.
- Après un élagage, la fenêtre TTL se réinitialise donc les requêtes suivantes gardent le cache jusqu'à ce que `ttl` expire à nouveau.

## Valeurs par défaut intelligentes (Anthropic)

- Profils **OAuth ou setup-token** : activent l'élagage `cache-ttl` et définissent le heartbeat à `1h`.
- Profils **clé API** : activent l'élagage `cache-ttl`, définissent le heartbeat à `30m`, et mettent par défaut `cacheControlTtl` à `1h` sur les modèles Anthropic.
- Si vous définissez explicitement l'une de ces valeurs, OpenClaw ne les **remplace pas**.

## Ce que cela améliore (coût + comportement de cache)

- **Pourquoi élaguer :** Le cache d'invite Anthropic ne s'applique que dans le TTL. Si une session reste inactive après le TTL, la prochaine requête recache l'invite complète sauf si vous la rognez d'abord.
- **Ce qui devient moins cher :** l'élagage réduit la taille de **cacheWrite** pour cette première requête après l'expiration du TTL.
- **Pourquoi la réinitialisation TTL compte :** une fois que l'élagage s'exécute, la fenêtre de cache se réinitialise, donc les requêtes de suivi peuvent réutiliser l'invite fraîchement cachée au lieu de recacher tout l'historique à nouveau.
- **Ce qu'il ne fait pas :** l'élagage n'ajoute pas de jetons ou ne "double" pas les coûts ; il change seulement ce qui est caché sur cette première requête post-TTL.

## Ce qui peut être élagué

- Uniquement les messages `toolResult`.
- Les messages utilisateur + assistant ne sont **jamais** modifiés.
- Les derniers `keepLastAssistants` messages assistant sont protégés ; les résultats d'outils après cette coupure ne sont pas élagués.
- S'il n'y a pas assez de messages assistant pour établir la coupure, l'élagage est sauté.
- Les résultats d'outils contenant des **blocs d'image** sont sautés (jamais rognés/effacés).

## Estimation de fenêtre de contexte

L'élagage utilise une fenêtre de contexte estimée (chars ≈ jetons × 4). La fenêtre de base est résolue dans cet ordre :

1. Remplacement `models.providers.*.models[].contextWindow`.
2. Définition de modèle `contextWindow` (du registre de modèles).
3. Par défaut `200000` jetons.

Si `agents.defaults.contextTokens` est défini, il est traité comme un plafond (min) sur la fenêtre résolue.

## Mode

### cache-ttl

- L'élagage ne s'exécute que si le dernier appel Anthropic est plus ancien que `ttl` (par défaut `5m`).
- Quand il s'exécute : même comportement de rognage doux + effacement dur qu'avant.

## Élagage doux vs dur

- **Rognage doux** : uniquement pour les résultats d'outils surdimensionnés.
  - Garde tête + queue, insère `...` et ajoute une note avec la taille originale.
  - Saute les résultats avec blocs d'image.
- **Effacement dur** : remplace le résultat d'outil entier par `hardClear.placeholder`.

## Sélection d'outil

- `tools.allow` / `tools.deny` supportent les wildcards `*`.
- Deny gagne.
- La correspondance est insensible à la casse.
- Liste allow vide => tous les outils autorisés.

## Interaction avec d'autres limites

- Les outils intégrés tronquent déjà leur propre sortie ; l'élagage de session est une couche supplémentaire qui empêche les chats longue durée d'accumuler trop de sortie d'outil dans le contexte du modèle.
- La compaction est séparée : la compaction résume et persiste, l'élagage est transitoire par requête. Voir [/concepts/compaction](/fr-FR/concepts/compaction).

## Valeurs par défaut (quand activé)

- `ttl` : `"5m"`
- `keepLastAssistants` : `3`
- `softTrimRatio` : `0.3`
- `hardClearRatio` : `0.5`
- `minPrunableToolChars` : `50000`
- `softTrim` : `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear` : `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Exemples

Par défaut (off) :

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Activer l'élagage conscient du TTL :

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Restreindre l'élagage à des outils spécifiques :

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

Voir référence de config : [Configuration de passerelle](/fr-FR/gateway/configuration)
