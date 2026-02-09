---
summary: "Hantering av datum och tid över kuvert, promptar, verktyg och kopplingar"
read_when:
  - Du ändrar hur tidsstämplar visas för modellen eller användare
  - Du felsöker tidsformatering i meddelanden eller i systempromptens utdata
title: "Datum och tid"
---

# Datum och tid

OpenClaw standard är **värdlokal tid för transporttidsstämplar** och **användartidszon endast i systemprompten**.
Leverantörens tidsstämplar bevaras så att verktygen behåller sin ursprungliga semantik (aktuell tid finns tillgänglig via `session_status`).

## Meddelandekuvert (lokal som standard)

Inkommande meddelanden kapslas in med en tidsstämpel (minutprecision):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Denna kuvert‑tidsstämpel är **värd‑lokal som standard**, oavsett leverantörens tidszon.

Du kan åsidosätta detta beteende:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` använder UTC.
- `envelopeTimezone: "local"` använder värdens tidszon.
- `envelopeTimezone: "user"` använder `agents.defaults.userTimezone` (faller tillbaka till värdens tidszon).
- Använd en explicit IANA tidszon (t.ex., "Amerika/Chicago"\`) för en fast zon.
- `envelopeTimestamp: "off"` tar bort absoluta tidsstämplar från kuvert‑huvuden.
- `envelopeElapsed: "off"` tar bort suffix för förfluten tid (stilen `+2m`).

### Exempel

**Lokal (standard):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Användarens tidszon:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Förfluten tid aktiverad:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## Systemprompt: Aktuellt datum och tid

Om användarens tidszon är känd innehåller systemprompten en dedikerad sektion
**Aktuellt datum och tid** med **endast tidszonen** (ingen klocka/tidsformat)
för att hålla prompt‑cache stabil:

```
Time zone: America/Chicago
```

När agenten behöver aktuell tid ska du använda verktyget `session_status`; statuskortet
innehåller en tidsstämpelrad.

## Systemhändelserader (lokal som standard)

Köade systemhändelser som infogas i agentens kontext prefixeras med en tidsstämpel som använder
samma val av tidszon som meddelandekuvert (standard: värd‑lokal).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Konfigurera användarens tidszon + format

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` anger **användar‑lokal tidszon** för prompt‑kontext.
- `timeFormat`-kontroller **12h/24h display** i prompten. `auto` följer OS prefs.

## Detektering av tidsformat (auto)

När `timeFormat: "auto"`, OpenClaw inspekterar OS-inställningen (macOS/Windows)
och faller tillbaka till lokalformatering. Det upptäckta värdet är **cachelagrat per process**
för att undvika upprepade systemsamtal.

## Verktygslaster + kopplingar (rå leverantörstid + normaliserade fält)

Kanalverktyg returnerar **leverantörs‑inbyggda tidsstämplar** och lägger till normaliserade fält för konsekvens:

- `timestampMs`: epok‑millisekunder (UTC)
- `timestampUtc`: ISO 8601‑sträng i UTC

Rå leverantörsfält bevaras så att inget går förlorat.

- Slack: epok‑liknande strängar från API:t
- Discord: UTC‑ISO‑tidsstämplar
- Telegram/WhatsApp: leverantörsspecifika numeriska/ISO‑tidsstämplar

Om du behöver lokal tid, konvertera den nedströms med den kända tidszonen.

## Relaterad dokumentation

- [Systemprompt](/concepts/system-prompt)
- [Tidszoner](/concepts/timezone)
- [Meddelanden](/concepts/messages)
