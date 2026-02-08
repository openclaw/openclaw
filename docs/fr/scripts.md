---
summary: "Scripts du depôt : objectif, perimetre et notes de securite"
read_when:
  - Execution de scripts depuis le depôt
  - Ajout ou modification de scripts sous ./scripts
title: "Scripts"
x-i18n:
  source_path: scripts.md
  source_hash: efd220df28f20b33
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:02:44Z
---

# Scripts

Le repertoire `scripts/` contient des scripts d’aide pour les flux de travail locaux et les taches d’exploitation.
Utilisez-les lorsque la tache est clairement liee a un script ; sinon, privilegiez la CLI.

## Conventions

- Les scripts sont **optionnels** sauf s’ils sont references dans la documentation ou les checklists de version.
- Privilegiez les interfaces CLI lorsqu’elles existent (exemple : la surveillance de l’authentification utilise `openclaw models status --check`).
- Considerer les scripts comme specifiques a l’hote ; lisez-les avant de les executer sur une nouvelle machine.

## Scripts de surveillance de l’authentification

Les scripts de surveillance de l’authentification sont documentes ici :
[/automation/auth-monitoring](/automation/auth-monitoring)

## Lors de l’ajout de scripts

- Gardez les scripts concis et documentes.
- Ajoutez une courte entree dans la documentation pertinente (ou creez-en une si elle manque).
