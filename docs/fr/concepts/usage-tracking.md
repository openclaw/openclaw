---
summary: "Surfaces de suivi d’utilisation et exigences d’identification"
read_when:
  - Vous raccordez des surfaces d’utilisation/quota des fournisseurs
  - Vous devez expliquer le comportement du suivi d’utilisation ou les exigences d’authentification
title: "Suivi d’utilisation"
---

# Suivi d’utilisation

## De quoi s’agit‑il

- Récupère l’utilisation/les quotas des fournisseurs directement depuis leurs points de terminaison d’utilisation.
- Aucun coût estimé ; uniquement les fenêtres déclarées par le fournisseur.

## Où cela apparaît

- `/status` dans les chats : carte d’état riche en émojis avec les jetons de session + le coût estimé (clé API uniquement). L’utilisation du fournisseur s’affiche pour le **fournisseur de modèle actuel** lorsque disponible.
- `/usage off|tokens|full` dans les chats : pied de page d’utilisation par réponse (OAuth affiche uniquement les jetons).
- `/usage cost` dans les chats : résumé local des coûts agrégé à partir des journaux de session OpenClaw.
- CLI : `openclaw status --usage` imprime un détail complet par fournisseur.
- CLI : `openclaw channels list` imprime le même instantané d’utilisation à côté de la configuration du fournisseur (utilisez `--no-usage` pour ignorer).
- Barre de menus macOS : section « Usage » sous Contexte (uniquement si disponible).

## Fournisseurs + identifiants

- **Anthropic (Claude)** : jetons OAuth dans les profils d’authentification.
- **GitHub Copilot** : jetons OAuth dans les profils d’authentification.
- **Gemini CLI** : jetons OAuth dans les profils d’authentification.
- **Antigravity** : jetons OAuth dans les profils d’authentification.
- **OpenAI Codex** : jetons OAuth dans les profils d’authentification (accountId utilisé lorsqu’il est présent).
- **MiniMax** : clé API (clé du plan de codage ; `MINIMAX_CODE_PLAN_KEY` ou `MINIMAX_API_KEY`) ; utilise la fenêtre du plan de codage de 5 heures.
- **z.ai** : clé API via l’env/la configuration/le magasin d’authentification.

L’utilisation est masquée si aucun identifiant OAuth/API correspondant n’existe.
