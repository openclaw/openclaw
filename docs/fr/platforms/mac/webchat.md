---
summary: "Comment l’app mac integre le WebChat de la Gateway (passerelle) et comment le deboguer"
read_when:
  - Debogage de la vue WebChat mac ou du port loopback
title: "WebChat"
---

# WebChat (app macOS)

L’app de barre de menus macOS integre l’interface WebChat en tant que vue SwiftUI native. Elle
se connecte a la Gateway (passerelle) et utilise par defaut la **session principale** pour l’agent
selectionne (avec un selecteur de session pour les autres sessions).

- **Mode local** : se connecte directement au WebSocket local de la Gateway (passerelle).
- **Mode distant** : transfere le port de controle de la Gateway (passerelle) via SSH et utilise ce
  tunnel comme plan de donnees.

## Lancement et debogage

- Manuel : menu Lobster → « Ouvrir le chat ».

- Ouverture automatique pour les tests :

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Journaux : `./scripts/clawlog.sh` (sous-systeme `bot.molt`, categorie `WebChatSwiftUI`).

## Comment il est câblé

- Plan de donnees : methodes WS de la Gateway (passerelle) `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` et evenements `chat`, `agent`, `presence`, `tick`, `health`.
- Session : par defaut la session primaire (`main`, ou `global` lorsque la portee est
  globale). L’interface peut basculer entre les sessions.
- La prise en main utilise une session dediee afin de separer la configuration du premier lancement.

## Surface de securite

- Le mode distant ne transfere via SSH que le port de controle WebSocket de la Gateway (passerelle).

## Limitations connues

- L’interface est optimisee pour les sessions de chat (pas un sandbox de navigateur complet).
