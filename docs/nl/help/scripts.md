---
summary: "Repositoryscripts: doel, reikwijdte en veiligheidsopmerkingen"
read_when:
  - Scripts uit de repo uitvoeren
  - Scripts toevoegen of wijzigen onder ./scripts
title: "Scripts"
---

# Scripts

De directory `scripts/` bevat hulpscripts voor lokale workflows en operationele taken.
Gebruik deze wanneer een taak duidelijk aan een script is gekoppeld; geef anders de voorkeur aan de CLI.

## Conventies

- Scripts zijn **optioneel** tenzij ze worden genoemd in documentatie of releasechecklists.
- Geef de voorkeur aan CLI-oppervlakken wanneer die bestaan (bijvoorbeeld: auth-monitoring gebruikt `openclaw models status --check`).
- Ga ervan uit dat scripts hostspecificiek zijn; lees ze voordat je ze op een nieuwe machine uitvoert.

## Auth-monitoringscripts

Auth-monitoringscripts worden hier gedocumenteerd:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Bij het toevoegen van scripts

- Houd scripts gericht en gedocumenteerd.
- Voeg een korte vermelding toe in de relevante documentatie (of maak er een aan als die ontbreekt).
