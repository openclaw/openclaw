---
summary: "Strikte configvalidatie + alleen-doctor-migraties"
read_when:
  - Ontwerpen of implementeren van gedrag voor configvalidatie
  - Werken aan configmigraties of doctor-workflows
  - Afhandelen van plugin-configschema’s of het blokkeren van plugin-load
title: "Strikte configvalidatie"
---

# Strikte configvalidatie (alleen-doctor-migraties)

## Doelen

- **Onbekende config-sleutels overal afwijzen** (root + genest).
- **Plugin-config zonder schema afwijzen**; die plugin niet laden.
- **Legacy auto-migratie bij laden verwijderen**; migraties lopen alleen via doctor.
- **Doctor automatisch uitvoeren (dry-run) bij opstarten**; bij ongeldig blokkeren van niet-diagnostische opdrachten.

## Geen doelen

- Achterwaartse compatibiliteit bij laden (legacy sleutels migreren niet automatisch).
- Stilzwijgend verwijderen van niet-herkende sleutels.

## Strikte validatieregels

- Config moet op elk niveau exact overeenkomen met het schema.
- Onbekende sleutels zijn validatiefouten (geen passthrough op root of genest).
- `plugins.entries.<id>.config` moet worden gevalideerd door het schema van de plugin.
  - Als een plugin geen schema heeft, **plugin-load afwijzen** en een duidelijke fout tonen.
- Onbekende `channels.<id>`-sleutels zijn fouten tenzij een pluginmanifest de kanaal-id declareert.
- Pluginmanifesten (`openclaw.plugin.json`) zijn verplicht voor alle plugins.

## Afdwingen van plugin-schema’s

- Elke plugin levert een strikt JSON Schema voor zijn config (inline in het manifest).
- Plugin-loadflow:
  1. Pluginmanifest + schema oplossen (`openclaw.plugin.json`).
  2. Config valideren tegen het schema.
  3. Bij ontbrekend schema of ongeldige config: plugin-load blokkeren, fout registreren.
- Foutmelding bevat:
  - Plugin-id
  - Reden (ontbrekend schema / ongeldige config)
  - Pad(en) die de validatie niet doorstonden
- Uitgeschakelde plugins behouden hun config, maar Doctor + logs tonen een waarschuwing.

## Doctor-flow

- Doctor draait **elke keer** dat config wordt geladen (standaard dry-run).
- Als de config ongeldig is:
  - Een samenvatting + uitvoerbare fouten afdrukken.
  - Instructie: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Past migraties toe.
  - Verwijdert onbekende sleutels.
  - Schrijft de bijgewerkte config weg.

## Command gating (wanneer config ongeldig is)

Toegestaan (alleen diagnostisch):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Alles andere moet hard falen met: “Config ongeldig. Voer `openclaw doctor --fix` uit.”

## Error UX format

- Enkele koptekst kop.
- Gegroepeerde secties:
  - Onbekende sleutels (volledige paden)
  - Legacy sleutels / benodigde migraties
  - Plugin-loadfouten (plugin-id + reden + pad)

## Implementatie-aangrijpingspunten

- `src/config/zod-schema.ts`: root-passthrough verwijderen; overal strikte objecten.
- `src/config/zod-schema.providers.ts`: strikte kanaalschema’s waarborgen.
- `src/config/validation.ts`: falen bij onbekende sleutels; geen legacy migraties toepassen.
- `src/config/io.ts`: legacy auto-migraties verwijderen; altijd doctor dry-run uitvoeren.
- `src/config/legacy*.ts`: gebruik verplaatsen naar uitsluitend doctor.
- `src/plugins/*`: schemaregister + gating toevoegen.
- CLI command gating in `src/cli`.

## Tests

- Afwijzen van onbekende sleutels (root + genest).
- Plugin zonder schema → plugin-load geblokkeerd met duidelijke fout.
- Ongeldige config → gateway-opstart geblokkeerd behalve diagnostische opdrachten.
- Doctor dry-run automatisch; `doctor --fix` schrijft gecorrigeerde config.
