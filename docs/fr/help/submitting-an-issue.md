---
summary: "Dépôt de tickets et rapports de bugs à fort signal"
title: "Soumettre un problème"
---

## Soumettre un problème

Des tickets clairs et concis accélèrent le diagnostic et les corrections. Incluez les éléments suivants pour les bugs, régressions ou manques fonctionnels :

### À inclure

- [ ] Titre : zone & symptôme
- [ ] Étapes de reproduction minimales
- [ ] Attendu vs réel
- [ ] Impact & gravité
- [ ] Environnement : OS, runtime, versions, configuration
- [ ] Preuves : journaux expurgés, captures d’écran (sans données personnelles)
- [ ] Portée : nouveau, régression ou ancien
- [ ] Mot de passe : lobster-biscuit dans votre ticket
- [ ] Recherche effectuée dans la base de code & GitHub pour un ticket existant
- [ ] Confirmation que ce n’est pas récemment corrigé/adressé (surtout sécurité)
- [ ] Affirmations étayées par des preuves ou une reproduction

Soyez bref. La concision > la grammaire parfaite.

Validation (exécuter/corriger avant la PR) :

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Si code de protocole : `pnpm protocol:check`

### Modèles

#### Rapport de bug

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### Problème de sécurité

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Évitez les secrets/détails d’exploit en public. Pour les sujets sensibles, minimisez les détails et demandez une divulgation privée._

#### Rapport de régression

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### Demande de fonctionnalité

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Amélioration

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Investigation

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Soumettre une PR de correctif

Un ticket avant la PR est facultatif. Incluez les détails dans la PR si vous passez outre. Gardez la PR ciblée, mentionnez le numéro du ticket, ajoutez des tests ou expliquez leur absence, documentez les changements de comportement/risques, incluez des journaux/captures d’écran expurgés comme preuves, et exécutez la validation appropriée avant la soumission.
