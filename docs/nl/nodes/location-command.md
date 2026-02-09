---
summary: "Locatie-opdracht voor nodes (location.get), permissiemodi en achtergrondgedrag"
read_when:
  - Ondersteuning voor locatienodes of permissie-UI toevoegen
  - Achtergrondlocatie- en pushstromen ontwerpen
title: "Locatie-opdracht"
---

# Locatie-opdracht (nodes)

## TL;DR

- `location.get` is een node-opdracht (via `node.invoke`).
- Standaard uit.
- Instellingen gebruiken een selector: Uit / Tijdens gebruik / Altijd.
- Aparte schakelaar: Nauwkeurige locatie.

## Waarom een selector (niet alleen een schakelaar)

OS-permissies zijn meerlagig. We kunnen in de app een selector aanbieden, maar het OS bepaalt nog steeds de daadwerkelijke toekenning.

- iOS/macOS: de gebruiker kan **Tijdens gebruik** of **Altijd** kiezen in systeemmeldingen/Instellingen. De app kan een upgrade aanvragen, maar het OS kan Instellingen vereisen.
- Android: achtergrondlocatie is een aparte permissie; op Android 10+ vereist dit vaak een Instellingen-stroom.
- Nauwkeurige locatie is een aparte toekenning (iOS 14+ “Nauwkeurig”, Android “fijn” vs “grof”).

De selector in de UI stuurt onze aangevraagde modus; de daadwerkelijke toekenning staat in de OS-instellingen.

## Instellingenmodel

Per node-apparaat:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI-gedrag:

- Het selecteren van `whileUsing` vraagt voorgrondpermissie aan.
- Het selecteren van `always` zorgt eerst voor `whileUsing`, en vraagt daarna achtergrondpermissie aan (of stuurt de gebruiker naar Instellingen indien vereist).
- Als het OS het aangevraagde niveau weigert, keer terug naar het hoogste toegekende niveau en toon de status.

## Permissietoewijzing (node.permissions)

Optioneel. De macOS-node rapporteert `location` via de permissiemap; iOS/Android kunnen dit weglaten.

## Opdracht: `location.get`

Aangeroepen via `node.invoke`.

Parameters (voorgesteld):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Response-payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Fouten (stabiele codes):

- `LOCATION_DISABLED`: selector staat uit.
- `LOCATION_PERMISSION_REQUIRED`: permissie ontbreekt voor de aangevraagde modus.
- `LOCATION_BACKGROUND_UNAVAILABLE`: app staat op de achtergrond maar alleen Tijdens gebruik is toegestaan.
- `LOCATION_TIMEOUT`: geen fix binnen de tijd.
- `LOCATION_UNAVAILABLE`: systeemfout / geen providers.

## Achtergrondgedrag (toekomst)

Doel: het model kan locatie opvragen zelfs wanneer de node op de achtergrond staat, maar alleen wanneer:

- De gebruiker **Altijd** heeft geselecteerd.
- Het OS achtergrondlocatie toekent.
- De app toestemming heeft om op de achtergrond te draaien voor locatie (iOS-achtergrondmodus / Android-foregroundservice of speciale toelating).

Push-geactiveerde stroom (toekomst):

1. De Gateway stuurt een push naar de node (stille push of FCM-data).
2. De node wordt kort gewekt en vraagt locatie op bij het apparaat.
3. De node stuurt de payload door naar de Gateway.

Notities:

- iOS: Altijd-permissie + achtergrondlocatiemodus vereist. Stille push kan worden gethrottled; verwacht intermittente mislukkingen.
- Android: achtergrondlocatie kan een foregroundservice vereisen; anders is weigering te verwachten.

## Model-/toolingintegratie

- Tool-oppervlak: de `nodes` tool voegt de `location_get`-actie toe (node vereist).
- CLI: `openclaw nodes location get --node <id>`.
- Agent-richtlijnen: alleen aanroepen wanneer de gebruiker locatie heeft ingeschakeld en de reikwijdte begrijpt.

## UX-tekst (voorgesteld)

- Uit: “Locatiedeling is uitgeschakeld.”
- Tijdens gebruik: “Alleen wanneer OpenClaw open is.”
- Altijd: “Achtergrondlocatie toestaan. Vereist systeempermissie.”
- Nauwkeurig: “Gebruik nauwkeurige GPS-locatie. Schakel uit om een benaderende locatie te delen.”
