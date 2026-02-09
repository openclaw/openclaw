---
summary: "Strikt konfigvalidering + migreringar endast via doctor"
read_when:
  - Utformning eller implementering av beteende för konfigvalidering
  - Arbete med konfigmigreringar eller doctor-arbetsflöden
  - Hantering av plugin-konfigscheman eller spärrar för plugininläsning
title: "Strikt konfigvalidering"
---

# Strikt konfigvalidering (migreringar endast via doctor)

## Mål

- **Avvisa okända konfignycklar överallt** (rot + nästlade).
- **Avvisa plugin-konfig utan schema**; ladda inte den pluginen.
- **Ta bort äldre automatisk migrering vid inläsning**; migreringar körs endast via doctor.
- **Kör doctor automatiskt (dry-run) vid start**; om ogiltigt, blockera icke-diagnostiska kommandon.

## Icke-mål

- Bakåtkompatibilitet vid inläsning (äldre nycklar auto-migreras inte).
- Tyst borttagning av okända nycklar.

## Regler för strikt validering

- Konfig måste matcha schemat exakt på varje nivå.
- Okända nycklar är valideringsfel (ingen passthrough på rot eller nästlat).
- `plugins.entries.<id>.config` måste valideras av plugins schema.
  - Om en plugin saknar schema, **avvisa plugininläsning** och visa ett tydligt fel.
- Okända `kanaler.<id>` nycklar är fel om inte ett plugin manifest deklarerar kanal-id.
- Pluginmanifest (`openclaw.plugin.json`) krävs för alla plugins.

## Tvingande plugin-schema

- Varje plugin tillhandahåller ett strikt JSON Schema för sin konfig (inline i manifestet).
- Flöde för plugininläsning:
  1. Lös pluginmanifest + schema (`openclaw.plugin.json`).
  2. Validera konfig mot schemat.
  3. Om schema saknas eller konfig är ogiltig: blockera plugininläsning, registrera fel.
- Felmeddelandet innehåller:
  - Plugin-id
  - Orsak (saknat schema / ogiltig konfig)
  - Sökväg(ar) som misslyckades i valideringen
- Inaktiverade plugins behåller sin konfig, men Doctor + loggar visar en varning.

## Doctor-flöde

- Doctor körs **varje gång** konfig läses in (dry-run som standard).
- Om konfig är ogiltig:
  - Skriv ut en sammanfattning + åtgärdbara fel.
  - Instruktion: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Tillämpar migreringar.
  - Tar bort okända nycklar.
  - Skriver uppdaterad konfig.

## Kommando-spärrar (när konfig är ogiltig)

Tillåtna (endast diagnostik):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Allt annat måste vara svårt att misslyckas med: ”Konfigurera ogiltigt. Kör `openclaw doctor --fix`.”

## Fel-UX-format

- En enda sammanfattningsrubrik.
- Grupperade avsnitt:
  - Okända nycklar (fullständiga sökvägar)
  - Äldre nycklar / migreringar som behövs
  - Plugininläsningsfel (plugin-id + orsak + sökväg)

## Implementeringsberöringspunkter

- `src/config/zod-schema.ts`: ta bort passthrough på rot; strikta objekt överallt.
- `src/config/zod-schema.providers.ts`: säkerställ strikta kanalscheman.
- `src/config/validation.ts`: fallera på okända nycklar; tillämpa inte äldre migreringar.
- `src/config/io.ts`: ta bort äldre automigreringar; kör alltid doctor dry-run.
- `src/config/legacy*.ts`: flytta användning till endast doctor.
- `src/plugins/*`: lägg till schemaregister + spärrar.
- CLI-kommando-spärrar i `src/cli`.

## Tester

- Avvisning av okända nycklar (rot + nästlade).
- Plugin saknar schema → plugininläsning blockeras med tydligt fel.
- Ogiltig konfig → gateway-start blockeras förutom diagnostiska kommandon.
- Doctor dry-run automatiskt; `doctor --fix` skriver korrigerad konfig.
