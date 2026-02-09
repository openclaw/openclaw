---
summary: "Platskommando för noder (location.get), behörighetslägen och bakgrundsbeteende"
read_when:
  - Lägger till stöd för platsnoder eller behörighets-UI
  - Utformar flöden för bakgrundsplats + push
title: "Platskommando"
---

# Platskommando (noder)

## TL;DR

- `location.get` är ett nodkommando (via `node.invoke`).
- Avstängt som standard.
- Inställningar använder en väljare: Av / Vid användning / Alltid.
- Separat reglage: Exakt plats.

## Varför en väljare (inte bara en strömbrytare)

OS-behörigheter är flera nivåer. Vi kan exponera en väljare i appen, men OS bestämmer fortfarande själva bidraget.

- iOS/macOS: användaren kan välja **Under Användning** eller **alltid** i systemuppmaningar/inställningar. Appen kan begära uppgradering, men OS kan kräva inställningar.
- Android: bakgrundsplats är en separat behörighet; på Android 10+ kräver den ofta ett Inställningsflöde.
- Exakt plats är en separat tilldelning (iOS 14+ ”Exakt”, Android ”fine” vs ”coarse”).

Väljaren i UI styr vårt begärda läge; den faktiska tilldelningen finns i OS-inställningarna.

## Inställningsmodell

Per nodenhet:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI-beteende:

- Val av `whileUsing` begär behörighet i förgrunden.
- Val av `always` säkerställer först `whileUsing`, begär sedan bakgrund (eller skickar användaren till Inställningar om det krävs).
- Om OS nekar begärd nivå, återgå till högsta beviljade nivå och visa status.

## Behörighetsmappning (node.permissions)

Valfritt. macOS nod rapporter `location` via behörighetskartan; iOS/Android kan utelämna det.

## Kommando: `location.get`

Anropas via `node.invoke`.

Parametrar (föreslagna):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Svarspayload:

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

Fel (stabila koder):

- `LOCATION_DISABLED`: väljaren är av.
- `LOCATION_PERMISSION_REQUIRED`: behörighet saknas för begärt läge.
- `LOCATION_BACKGROUND_UNAVAILABLE`: appen är i bakgrunden men endast Vid användning tillåts.
- `LOCATION_TIMEOUT`: ingen fix i tid.
- `LOCATION_UNAVAILABLE`: systemfel / inga leverantörer.

## Bakgrundsbeteende (framtida)

Mål: modellen kan begära plats även när noden är i bakgrunden, men endast när:

- Användaren har valt **Alltid**.
- OS beviljar bakgrundsplats.
- Appen tillåts köra i bakgrunden för plats (iOS bakgrundsläge / Android foreground service eller särskilt tillstånd).

Push-utlöst flöde (framtida):

1. Gateway skickar en push till noden (tyst push eller FCM-data).
2. Noden vaknar kort och begär plats från enheten.
3. Noden vidarebefordrar payload till Gateway.

Noteringar:

- iOS: Alltid behörighet + bakgrundsplats krävs. Tyst tryck kan strypas, förvänta intermittent misslyckanden.
- Android: bakgrundsplats kan kräva en foreground service; annars kan man förvänta sig nekande.

## Modell-/verktygsintegration

- Verktygsyta: `nodes`-verktyget lägger till åtgärden `location_get` (nod krävs).
- CLI: `openclaw nodes location get --node <id>`.
- Agentriktlinjer: anropa endast när användaren har aktiverat plats och förstår omfattningen.

## UX-copy (föreslaget)

- Av: ”Platsdelning är inaktiverad.”
- Vid användning: ”Endast när OpenClaw är öppet.”
- Alltid: “Tillåt bakgrundsplats. Kräver systembehörighet.”
- Precise: ”Använd exakt GPS-position. Växla av för att dela ungefärlig plats. "
