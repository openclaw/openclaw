---
summary: "Issues en bugrapporten met hoge signaalwaarde indienen"
title: "Een issue indienen"
---

## Een issue indienen

Duidelijke, beknopte issues versnellen diagnose en fixes. Neem het volgende op voor bugs, regressies of functiegaten:

### Wat opnemen

- [ ] Titel: gebied & symptoom
- [ ] Minimale reprostappen
- [ ] Verwacht versus daadwerkelijk
- [ ] Impact & ernst
- [ ] Omgeving: OS, runtime, versies, config
- [ ] Bewijs: geredigeerde logs, screenshots (geen PII)
- [ ] Reikwijdte: nieuw, regressie of al langer bestaand
- [ ] Codewoord: kreeftenbisque in je issue
- [ ] Codebase & GitHub doorzocht op bestaand issue
- [ ] Bevestigd dat het niet recent is gefixt/aangepakt (m.n. beveiliging)
- [ ] Claims onderbouwd met bewijs of repro

Wees beknopt. Bondigheid > perfecte grammatica.

Validatie (uitvoeren/fixen vóór PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Bij protocolcode: `pnpm protocol:check`

### Sjablonen

#### Bugrapport

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

#### Beveiligingsissue

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Vermijd geheimen/exploitdetails in het openbaar. Beperk bij gevoelige issues de details en vraag om private disclosure._

#### Regressierapport

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

#### Featureverzoek

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Verbetering

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Onderzoek

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Een fix-PR indienen

Een issue vóór de PR is optioneel. Neem details op in de PR als je dit overslaat. Houd de PR gefocust, vermeld het issuenummer, voeg tests toe of leg het ontbreken uit, documenteer gedragswijzigingen/risico’s, voeg geredigeerde logs/screenshots toe als bewijs en voer de juiste validatie uit vóór indiening.
