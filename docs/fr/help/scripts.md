---
summary: "Scripts du dépôt : objectif, périmètre et notes de sécurité"
read_when:
  - Exécuter des scripts depuis le dépôt
  - Ajouter ou modifier des scripts sous ./scripts
title: "Scripts"
---

# Scripts

Le répertoire `scripts/` contient des scripts d’assistance pour les workflows locaux et les tâches d’exploitation.
Utilisez‑les lorsqu’une tâche est clairement liée à un script ; sinon, privilégiez la CLI.

## Conventions

- Les scripts sont **optionnels**, sauf s’ils sont référencés dans la documentation ou les checklists de publication.
- Préférez les interfaces CLI lorsqu’elles existent (exemple : la surveillance de l’authentification utilise `openclaw models status --check`).
- Considérez que les scripts sont spécifiques à l’hôte ; lisez‑les avant de les exécuter sur une nouvelle machine.

## Scripts de surveillance de l’authentification

Les scripts de surveillance de l’authentification sont documentés ici :
[/automation/auth-monitoring](/automation/auth-monitoring)

## Lors de l’ajout de scripts

- Gardez les scripts ciblés et documentés.
- Ajoutez une courte entrée dans la documentation pertinente (ou créez‑en une si elle manque).
