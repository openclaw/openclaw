---
summary: "Renforcer la gestion des entrées de cron.add, aligner les schémas et améliorer les outils cron de l’UI et de l’agent"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Renforcement de Cron Add"
---

# Renforcement de Cron Add et alignement des schémas

## Contexte

Des journaux récents de la Gateway (passerelle) montrent des échecs répétés `cron.add` avec des paramètres invalides (absence de `sessionTarget`, `wakeMode`, `payload`, et `schedule` mal formé). Cela indique qu’au moins un client (probablement le chemin d’appel de l’outil de l’agent) envoie des charges utiles de tâches enveloppées ou partiellement spécifiées. Par ailleurs, il existe une dérive entre les énumérations de fournisseurs cron dans TypeScript, le schéma de la Gateway (passerelle), les indicateurs CLI et les types de formulaires de l’UI, ainsi qu’une incohérence de l’UI pour `cron.status` (attend `jobCount` alors que la Gateway (passerelle) renvoie `jobs`).

## Objectifs

- Mettre fin au spam `cron.add` INVALID_REQUEST en normalisant les charges utiles enveloppées courantes et en inférant les champs `kind` manquants.
- Aligner les listes de fournisseurs cron entre le schéma de la Gateway (passerelle), les types cron, la documentation CLI et les formulaires de l’UI.
- Rendre explicite le schéma de l’outil cron de l’agent afin que le LLM produise des charges utiles de tâches correctes.
- Corriger l’affichage du nombre de tâches du statut cron dans l’UI de contrôle.
- Ajouter des tests pour couvrir la normalisation et le comportement de l’outil.

## Hors objectifs

- Modifier la sémantique de planification cron ou le comportement d’exécution des tâches.
- Ajouter de nouveaux types de planification ou l’analyse d’expressions cron.
- Repenser l’UI/UX de cron au-delà des corrections de champs nécessaires.

## Constatations (écarts actuels)

- `CronPayloadSchema` dans la Gateway (passerelle) exclut `signal` + `imessage`, alors que les types TS les incluent.
- CronStatus de l’UI de contrôle attend `jobCount`, mais la Gateway (passerelle) renvoie `jobs`.
- Le schéma de l’outil cron de l’agent autorise des objets `job` arbitraires, permettant des entrées mal formées.
- La Gateway (passerelle) valide strictement `cron.add` sans normalisation, de sorte que les charges utiles enveloppées échouent.

## Ce qui a changé

- `cron.add` et `cron.update` normalisent désormais les formes d’enveloppe courantes et infèrent les champs `kind` manquants.
- Le schéma de l’outil cron de l’agent correspond au schéma de la Gateway (passerelle), ce qui réduit les charges utiles invalides.
- Les énumérations de fournisseurs sont alignées entre la Gateway (passerelle), le CLI, l’UI et le sélecteur macOS.
- L’UI de contrôle utilise le champ de comptage `jobs` de la Gateway (passerelle) pour l’état.

## Comportement actuel

- **Normalisation :** les charges utiles enveloppées `data`/`job` sont déballées ; `schedule.kind` et `payload.kind` sont inférés lorsque c’est sûr.
- **Valeurs par défaut :** des valeurs par défaut sûres sont appliquées pour `wakeMode` et `sessionTarget` lorsqu’elles sont absentes.
- **Fournisseurs :** Discord/Slack/Signal/iMessage sont désormais exposés de manière cohérente dans le CLI et l’UI.

Voir [Cron jobs](/automation/cron-jobs) pour la forme normalisée et des exemples.

## Vérification

- Surveiller les journaux de la Gateway (passerelle) pour constater une réduction des erreurs `cron.add` INVALID_REQUEST.
- Confirmer que l’état cron de l’UI de contrôle affiche le nombre de tâches après actualisation.

## Suivis optionnels

- Test manuel de l’UI de contrôle : ajouter une tâche cron par fournisseur et vérifier le nombre de tâches du statut.

## Questions ouvertes

- `cron.add` devrait-il accepter un `state` explicite de la part des clients (actuellement interdit par le schéma) ?
- Devrait-on autoriser `webchat` comme fournisseur de livraison explicite (actuellement filtré lors de la résolution de livraison) ?
