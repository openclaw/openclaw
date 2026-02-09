---
summary: "Comment soumettre une PR à fort signal"
title: "Soumettre une PR"
---

Les bonnes PR sont faciles à relire : les reviewers doivent rapidement comprendre l’intention, vérifier le comportement et intégrer les changements en toute sécurité. Ce guide couvre des soumissions concises et à fort signal pour une relecture humaine et par LLM.

## Qu’est-ce qui fait une bonne PR

- [ ] Expliquer le problème, pourquoi il est important et le changement apporté.
- [ ] Garder des changements ciblés. Éviter les refactorisations larges.
- [ ] Résumer les changements visibles par l’utilisateur / de configuration / de valeurs par défaut.
- [ ] Lister la couverture de tests, les exclusions et les raisons.
- [ ] Ajouter des preuves : logs, captures d’écran ou enregistrements (UI/UX).
- [ ] Mot de code : mettez « lobster-biscuit » dans la description de la PR si vous avez lu ce guide.
- [ ] Exécuter/corriger les commandes `pnpm` pertinentes avant de créer la PR.
- [ ] Rechercher dans la base de code et sur GitHub les fonctionnalités/problèmes/correctifs liés.
- [ ] Fonder les affirmations sur des preuves ou des observations.
- [ ] Bon titre : verbe + périmètre + résultat (p. ex., `Docs: add PR and issue templates`).

Soyez concis ; une relecture concise > la grammaire. Omettez toute section non applicable.

### Commandes de validation de base (exécuter/corriger les échecs pour votre changement)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Changements de protocole : `pnpm protocol:check`

## Divulgation progressive

- En haut : résumé/intention
- Ensuite : changements/risques
- Ensuite : tests/vérification
- Enfin : implémentation/preuves

## Types de PR courants : points spécifiques

- [ ] Correctif : ajouter un repro, la cause racine, la vérification.
- [ ] Fonctionnalité : ajouter des cas d’usage, comportements/démos/captures d’écran (UI).
- [ ] Refactorisation : indiquer « aucun changement de comportement », lister ce qui a été déplacé/simplifié.
- [ ] Tâche : indiquer pourquoi (p. ex., temps de build, CI, dépendances).
- [ ] Documentation : contexte avant/après, lien vers la page mise à jour, exécuter `pnpm format`.
- [ ] Test : quel manque est couvert ; comment cela empêche les régressions.
- [ ] Performance : ajouter des métriques avant/après et la méthode de mesure.
- [ ] UX/UI : captures d’écran/vidéo, noter l’impact sur l’accessibilité.
- [ ] Infra/Build : environnements/validation.
- [ ] Sécurité : résumer le risque, le repro, la vérification, aucune donnée sensible. Affirmations étayées uniquement.

## Checklist

- [ ] Problème/intention clairs
- [ ] Portée ciblée
- [ ] Lister les changements de comportement
- [ ] Lister les tests et leurs résultats
- [ ] Étapes de test manuel (le cas échéant)
- [ ] Aucune donnée secrète/privée
- [ ] Basé sur des preuves

## Modèle général de PR

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## Modèles par type de PR (remplacez par votre type)

### Correctif

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Fonctionnalité

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refactorisation

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Tâche/Maintenance

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Documentation

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Test

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infra/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Sécurité

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
