---
summary: "Rituel d’amorçage de l’agent qui initialise l’espace de travail et les fichiers d’identité"
read_when:
  - Comprendre ce qui se passe lors de la première exécution de l’agent
  - Expliquer où se trouvent les fichiers d’amorçage
  - Déboguer la configuration d’identité lors de la prise en main
title: "Amorçage de l’agent"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:46Z
---

# Amorçage de l’agent

L’amorçage est le rituel de **première exécution** qui prépare l’espace de travail
de l’agent et collecte les informations d’identité. Il a lieu après la prise en
main, lorsque l’agent démarre pour la première fois.

## Ce que fait l’amorçage

Lors de la première exécution de l’agent, OpenClaw amorce l’espace de travail
(par défaut `~/.openclaw/workspace`) :

- Initialise `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Exécute un court rituel de questions-réponses (une question à la fois).
- Écrit l’identité et les préférences dans `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Supprime `BOOTSTRAP.md` une fois terminé afin que cela ne s’exécute qu’une seule fois.

## Où cela s’exécute

L’amorçage s’exécute toujours sur l’**hôte de la Gateway (passerelle)**. Si
l’application macOS se connecte à une Gateway distante, l’espace de travail et
les fichiers d’amorçage se trouvent sur cette machine distante.

<Note>
Lorsque la Gateway s’exécute sur une autre machine, modifiez les fichiers de
l’espace de travail sur l’hôte de la Gateway (par exemple, `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Documentation associée

- Prise en main de l’application macOS : [Onboarding](/start/onboarding)
- Organisation de l’espace de travail : [Agent workspace](/concepts/agent-workspace)
