---
summary: "Fenêtre de contexte et compaction : comment OpenClaw garde les sessions sous les limites du modèle"
read_when:
  - Vous voulez comprendre l'auto-compaction et /compact
  - Vous déboguez des sessions longues atteignant les limites de contexte
title: "Compaction"
---

# Fenêtre de contexte et compaction

Chaque modèle a une **fenêtre de contexte** (jetons max qu'il peut voir). Les chats longue durée accumulent des messages et résultats d'outils ; une fois que la fenêtre est serrée, OpenClaw **compacte** l'historique plus ancien pour rester dans les limites.

## Ce qu'est la compaction

La compaction **résume la conversation plus ancienne** en une entrée de résumé compacte et garde les messages récents intacts. Le résumé est stocké dans l'historique de session, donc les futures requêtes utilisent :

- Le résumé de compaction
- Les messages récents après le point de compaction

La compaction **persiste** dans l'historique JSONL de la session.

## Configuration

Utilisez le paramètre `agents.defaults.compaction` dans votre `openclaw.json` pour configurer le comportement de compaction (mode, jetons cibles, etc.).

## Auto-compaction (activée par défaut)

Quand une session approche ou dépasse la fenêtre de contexte du modèle, OpenClaw déclenche l'auto-compaction et peut réessayer la requête originale en utilisant le contexte compacté.

Vous verrez :

- `🧹 Auto-compaction complete` en mode verbose
- `/status` montrant `🧹 Compactions: <count>`

Avant la compaction, OpenClaw peut exécuter un tour de **vidage de mémoire silencieux** pour stocker
des notes durables sur disque. Voir [Mémoire](/fr-FR/concepts/memory) pour les détails et la config.

## Compaction manuelle

Utilisez `/compact` (optionnellement avec instructions) pour forcer un passage de compaction :

```
/compact Focus on decisions and open questions
```

## Source de fenêtre de contexte

La fenêtre de contexte est spécifique au modèle. OpenClaw utilise la définition de modèle du catalogue de fournisseur configuré pour déterminer les limites.

## Compaction vs élagage

- **Compaction** : résume et **persiste** dans JSONL.
- **Élagage de session** : rogne les vieux **résultats d'outils** uniquement, **en mémoire**, par requête.

Voir [/concepts/session-pruning](/fr-FR/concepts/session-pruning) pour les détails d'élagage.

## Conseils

- Utilisez `/compact` quand les sessions semblent rassis ou que le contexte est gonflé.
- Les grandes sorties d'outils sont déjà tronquées ; l'élagage peut réduire davantage l'accumulation de résultats d'outils.
- Si vous avez besoin d'une ardoise vierge, `/new` ou `/reset` démarre un nouvel id de session.
