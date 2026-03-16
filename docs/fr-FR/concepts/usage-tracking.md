---
summary: "Surfaces de suivi d'utilisation et exigences d'identifiants"
read_when:
  - Vous câblez les surfaces d'utilisation/quota de fournisseur
  - Vous devez expliquer le comportement de suivi d'utilisation ou les exigences d'authentification
title: "Suivi d'utilisation"
---

# Suivi d'utilisation

## Ce que c'est

- Tire l'utilisation/quota du fournisseur directement depuis leurs endpoints d'utilisation.
- Pas de coûts estimés ; uniquement les fenêtres reportées par le fournisseur.

## Où cela apparaît

- `/status` dans les chats : carte de statut riche en emojis avec jetons de session + coût estimé (clé API uniquement). L'utilisation du fournisseur s'affiche pour le **fournisseur de modèle actuel** quand disponible.
- `/usage off|tokens|full` dans les chats : pied de page d'utilisation par réponse (OAuth montre les jetons uniquement).
- `/usage cost` dans les chats : résumé de coût local agrégé depuis les journaux de session OpenClaw.
- CLI : `openclaw status --usage` imprime une ventilation complète par fournisseur.
- CLI : `openclaw channels list` imprime le même instantané d'utilisation à côté de la config de fournisseur (utilisez `--no-usage` pour sauter).
- Barre de menu macOS : section "Usage" sous Context (uniquement si disponible).

## Fournisseurs + identifiants

- **Anthropic (Claude)** : jetons OAuth dans les profils d'authentification.
- **GitHub Copilot** : jetons OAuth dans les profils d'authentification.
- **Gemini CLI** : jetons OAuth dans les profils d'authentification.
- **Antigravity** : jetons OAuth dans les profils d'authentification.
- **OpenAI Codex** : jetons OAuth dans les profils d'authentification (accountId utilisé quand présent).
- **MiniMax** : clé API (clé de plan de codage ; `MINIMAX_CODE_PLAN_KEY` ou `MINIMAX_API_KEY`) ; utilise la fenêtre de plan de codage de 5 heures.
- **z.ai** : clé API via env/config/magasin d'authentification.

L'utilisation est cachée si aucun identifiant OAuth/API correspondant n'existe.
