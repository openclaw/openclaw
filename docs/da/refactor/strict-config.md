---
summary: "Streng konfigurationsvalidering + doctor-kun-migreringer"
read_when:
  - Design eller implementering af adfærd for konfigurationsvalidering
  - Arbejde med konfigurationsmigreringer eller doctor-workflows
  - Håndtering af plugin-konfigurationsskemaer eller gating af plugin-indlæsning
title: "Streng konfigurationsvalidering"
---

# Streng konfigurationsvalidering (doctor-kun-migreringer)

## Mål

- **Afvis ukendte konfigurationsnøgler overalt** (rod + indlejret).
- **Afvis plugin-konfiguration uden et skema**; indlæs ikke det plugin.
- **Fjern legacy auto-migrering ved indlæsning**; migreringer køres kun via doctor.
- **Kør doctor automatisk (dry-run) ved opstart**; hvis ugyldig, bloker ikke-diagnostiske kommandoer.

## Ikke-mål

- Bagudkompatibilitet ved indlæsning (legacy-nøgler auto-migreres ikke).
- Tavs fjernelse af ugenkendte nøgler.

## Regler for streng validering

- Konfigurationen skal matche skemaet præcist på alle niveauer.
- Ukendte nøgler er valideringsfejl (ingen passthrough ved rod eller indlejret).
- `plugins.entries.<id>.config` skal valideres ved plugin's skema.
  - Hvis et plugin mangler et skema, **afvis indlæsning af pluginet** og vis en klar fejl.
- Ukendt `kanaler.<id>` nøgler er fejl, medmindre et plugin manifest erklærer kanal id.
- Plugin-manifester (`openclaw.plugin.json`) er påkrævet for alle plugins.

## Håndhævelse af plugin-skema

- Hvert plugin leverer et strengt JSON-skema for sin konfiguration (indlejret i manifestet).
- Plugin-indlæsningsflow:
  1. Løs plugin-manifest + skema (`openclaw.plugin.json`).
  2. Valider konfigurationen mod skemaet.
  3. Hvis skema mangler eller konfigurationen er ugyldig: bloker plugin-indlæsning, registrér fejl.
- Fejlmeddelelsen indeholder:
  - Plugin-id
  - Årsag (manglende skema / ugyldig konfiguration)
  - Sti(er), der fejlede valideringen
- Deaktiverede plugins beholder deres konfiguration, men Doctor + logs viser en advarsel.

## Doctor-flow

- Doctor kører **hver gang** konfigurationen indlæses (dry-run som standard).
- Hvis konfigurationen er ugyldig:
  - Udskriv et overblik + handlingsrettede fejl.
  - Instruér: `openclaw doctor --fix`.
- `openclaw doctor --fix`:
  - Anvender migreringer.
  - Fjerner ukendte nøgler.
  - Skriver opdateret konfiguration.

## Kommando-gating (når konfigurationen er ugyldig)

Tilladt (kun diagnostik):

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Alt andet skal fejle hårdnakket med: “Config ugyldig. Kør `openclaw læge --fix`.”

## Fejl-UX-format

- Én samlet overskrift.
- Grupperede sektioner:
  - Ukendte nøgler (fulde stier)
  - Legacy-nøgler / migreringer påkrævet
  - Plugin-indlæsningsfejl (plugin-id + årsag + sti)

## Implementeringsberøringspunkter

- `src/config/zod-schema.ts`: fjern rod-passthrough; strenge objekter overalt.
- `src/config/zod-schema.providers.ts`: sikre strenge kanalskemaer.
- `src/config/validation.ts`: fejle ved ukendte nøgler; anvend ikke legacy-migreringer.
- `src/config/io.ts`: fjern legacy auto-migreringer; kør altid doctor dry-run.
- `src/config/legacy*.ts`: flyt brug til kun doctor.
- `src/plugins/*`: tilføj skemaregister + gating.
- CLI-kommando-gating i `src/cli`.

## Tests

- Afvisning af ukendte nøgler (rod + indlejret).
- Plugin mangler skema → plugin-indlæsning blokeres med klar fejl.
- Ugyldig konfiguration → gateway-opstart blokeres undtagen diagnostiske kommandoer.
- Doctor dry-run automatisk; `doctor --fix` skriver korrigeret konfiguration.
