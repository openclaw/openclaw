---
summary: "Scripts du dépôt : objectif, portée et notes de sécurité"
read_when:
  - Exécution de scripts depuis le dépôt
  - Ajout ou modification de scripts sous ./scripts
title: "Scripts"
---

# Scripts

Le répertoire `scripts/` contient des scripts d'aide pour les workflows locaux et les tâches d'opérations.
Utilisez-les quand une tâche est clairement liée à un script ; sinon préférez la CLI.

## Conventions

- Les scripts sont **optionnels** sauf s'ils sont référencés dans les docs ou les checklists de version.
- Préférez les surfaces CLI quand elles existent (exemple : la surveillance d'auth utilise `openclaw models status --check`).
- Supposez que les scripts sont spécifiques à l'hôte ; lisez-les avant de les exécuter sur une nouvelle machine.

## Scripts de surveillance d'authentification

Les scripts de surveillance d'authentification sont documentés ici :
[/automation/auth-monitoring](/fr-FR/automation/auth-monitoring)

## Lors de l'ajout de scripts

- Gardez les scripts ciblés et documentés.
- Ajoutez une courte entrée dans le doc pertinent (ou créez-en un s'il manque).
