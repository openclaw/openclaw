---
summary: "Rituel de démarrage de l'agent qui initialise l'espace de travail et les fichiers d'identité"
read_when:
  - Comprendre ce qui se passe au premier démarrage de l'agent
  - Expliquer où se trouvent les fichiers d'initialisation
  - Déboguer la configuration d'identité lors de l'intégration
title: "Initialisation de l'agent"
sidebarTitle: "Initialisation"
---

# Initialisation de l'agent

L'initialisation est le **rituel de première exécution** qui prépare l'espace de travail de l'agent et collecte les détails d'identité. Elle se produit après l'intégration, lorsque l'agent démarre pour la première fois.

## Ce que fait l'initialisation

Lors du premier démarrage de l'agent, OpenClaw initialise l'espace de travail (par défaut `~/.openclaw/workspace`) :

- Crée les fichiers `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Exécute un court rituel de questions-réponses (une question à la fois).
- Écrit l'identité et les préférences dans `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Supprime `BOOTSTRAP.md` une fois terminé pour qu'il ne s'exécute qu'une seule fois.

## Où elle s'exécute

L'initialisation s'exécute toujours sur l'**hôte de la passerelle**. Si l'application macOS se connecte à une passerelle distante, l'espace de travail et les fichiers d'initialisation se trouvent sur cette machine distante.

<Note>
Lorsque la passerelle s'exécute sur une autre machine, modifiez les fichiers de l'espace de travail sur l'hôte de la passerelle (par exemple, `utilisateur@hote-passerelle:~/.openclaw/workspace`).
</Note>

## Documentation connexe

- Intégration de l'application macOS : [Intégration](/fr-FR/start/onboarding)
- Structure de l'espace de travail : [Espace de travail de l'agent](/fr-FR/concepts/agent-workspace)
