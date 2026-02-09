---
summary: "Lokationskommando for noder (location.get), tilladelsestilstande og baggrundsadfærd"
read_when:
  - Tilføjelse af understøttelse for lokationsnode eller tilladelses-UI
  - Design af baggrundslokation + push-flows
title: "Lokationskommando"
---

# Lokationskommando (noder)

## TL;DR

- `location.get` er en nodekommando (via `node.invoke`).
- Slået fra som standard.
- Indstillinger bruger en vælger: Fra / Mens i brug / Altid.
- Separat toggle: Præcis lokation.

## Hvorfor en vælger (ikke bare en kontakt)

OS tilladelser er flere niveauer. Vi kan afsløre en selector i app, men OS beslutter stadig det faktiske tilskud.

- iOS/macOS: bruger kan vælge **Når du bruger** eller **Altid** i systemprompts/Indstillinger. App kan anmode om opgradering, men OS kan kræve Indstillinger.
- Android: baggrundslokation er en separat tilladelse; på Android 10+ kræver det ofte et flow via Indstillinger.
- Præcis lokation er en separat tildeling (iOS 14+ “Præcis”, Android “fin” vs. “grov”).

Vælgeren i UI’et styrer den tilstand, vi anmoder om; den faktiske tildeling ligger i OS-indstillingerne.

## Indstillingsmodel

Per nodenhed:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI-adfærd:

- Valg af `whileUsing` anmoder om forgrundstilladelse.
- Valg af `always` sikrer først `whileUsing`, og anmoder derefter om baggrund (eller sender brugeren til Indstillinger, hvis det kræves).
- Hvis OS’et afviser det anmodede niveau, rulles tilbage til det højeste tildelte niveau, og status vises.

## Tilladelseskortlægning (node.permissions)

Valgfri. macOS node reports `location` via tilladelseskortet; iOS/Android kan udelade det.

## Kommando: `location.get`

Kaldes via `node.invoke`.

Parametre (foreslået):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Svar-payload:

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

Fejl (stabile koder):

- `LOCATION_DISABLED`: vælgeren er slået fra.
- `LOCATION_PERMISSION_REQUIRED`: tilladelse mangler for den anmodede tilstand.
- `LOCATION_BACKGROUND_UNAVAILABLE`: appen er i baggrunden, men kun Mens i brug er tilladt.
- `LOCATION_TIMEOUT`: ingen fix i tide.
- `LOCATION_UNAVAILABLE`: systemfejl / ingen udbydere.

## Baggrundsadfærd (fremtid)

Mål: modellen kan anmode om lokation, selv når noden er i baggrunden, men kun når:

- Brugeren har valgt **Altid**.
- OS’et tildeler baggrundslokation.
- Appen har tilladelse til at køre i baggrunden for lokation (iOS-baggrundstilstand / Android-foreground service eller særlig tilladelse).

Push-udløst flow (fremtid):

1. Gateway sender et push til noden (silent push eller FCM-data).
2. Noden vækkes kort og anmoder om lokation fra enheden.
3. Noden videresender payloaden til Gateway.

Noter:

- iOS: Altid tilladelse + baggrundsplaceringstilstand kræves. Lydløs tryk kan blive nedbrudt; forventer periodisk svigt.
- Android: baggrundslokation kan kræve en foreground service; ellers forvent afvisning.

## Model-/værktøjsintegration

- Værktøjsflade: `nodes`-værktøjet tilføjer `location_get`-handling (node påkrævet).
- CLI: `openclaw nodes location get --node <id>`.
- Agent-retningslinjer: kald kun, når brugeren har aktiveret lokation og forstår omfanget.

## UX-tekst (foreslået)

- Fra: “Lokationsdeling er deaktiveret.”
- Mens i brug: “Kun når OpenClaw er åben.”
- Altid: “Tillad baggrunds placering. Kræver systemtilladelse.”
- Præcis “Brug præcis GPS-placering. Slå fra for at dele omtrentlige placering.”
