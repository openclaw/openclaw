---
summary: "Håndtering af dato og tid på tværs af konvolutter, prompts, værktøjer og connectors"
read_when:
  - Du ændrer, hvordan tidsstempler vises for modellen eller brugere
  - Du fejlsøger tidsformatering i beskeder eller output fra systemprompten
title: "Dato og tid"
x-i18n:
  source_path: date-time.md
  source_hash: 753af5946a006215
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:12Z
---

# Dato & tid

OpenClaw bruger som standard **værtslokal tid til transporttidsstempler** og **kun brugerens tidszone i systemprompten**.
Udbyderens tidsstempler bevares, så værktøjer beholder deres oprindelige semantik (aktuel tid er tilgængelig via `session_status`).

## Beskedkonvolutter (lokal som standard)

Indgående beskeder indpakkes med et tidsstempel (minutpræcision):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Dette konvoluttidsstempel er **værtslokalt som standard**, uanset udbyderens tidszone.

Du kan tilsidesætte denne adfærd:

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

- `envelopeTimezone: "utc"` bruger UTC.
- `envelopeTimezone: "local"` bruger værtsens tidszone.
- `envelopeTimezone: "user"` bruger `agents.defaults.userTimezone` (falder tilbage til værtsens tidszone).
- Brug en eksplicit IANA-tidszone (f.eks. `"America/Chicago"`) for en fast zone.
- `envelopeTimestamp: "off"` fjerner absolutte tidsstempler fra konvoluthoveder.
- `envelopeElapsed: "off"` fjerner suffikser for forløbet tid (stilen `+2m`).

### Eksempler

**Lokal (standard):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Brugerens tidszone:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Forløbet tid aktiveret:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## Systemprompt: Aktuel dato & tid

Hvis brugerens tidszone er kendt, indeholder systemprompten en dedikeret
sektion **Aktuel dato & tid** med **kun tidszonen** (ingen klokkeslæt/tidsformat)
for at holde prompt-caching stabil:

```
Time zone: America/Chicago
```

Når agenten har brug for den aktuelle tid, skal du bruge værktøjet `session_status`; statuskortet
indeholder en linje med tidsstempel.

## Systemhændelseslinjer (lokal som standard)

Køede systemhændelser, der indsættes i agentkonteksten, får et tidsstempel som præfiks ved brug af
samme valg af tidszone som beskedkonvolutter (standard: værtslokal).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Konfigurer brugerens tidszone + format

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

- `userTimezone` angiver **brugerens lokale tidszone** for promptkontekst.
- `timeFormat` styrer **12t/24t-visning** i prompten. `auto` følger OS-præferencer.

## Registrering af tidsformat (automatisk)

Når `timeFormat: "auto"`, inspicerer OpenClaw OS-præferencen (macOS/Windows)
og falder tilbage til lokal formatering. Den registrerede værdi **cachelagres pr. proces**
for at undgå gentagne systemkald.

## Værktøjs-payloads + connectors (rå udbydertider + normaliserede felter)

Kanalværktøjer returnerer **udbyder-naturlige tidsstempler** og tilføjer normaliserede felter for konsistens:

- `timestampMs`: epoch-millisekunder (UTC)
- `timestampUtc`: ISO 8601 UTC-streng

Rå udbyderfelter bevares, så intet går tabt.

- Slack: epoch-lignende strenge fra API’et
- Discord: UTC ISO-tidsstempler
- Telegram/WhatsApp: udbyderspecifikke numeriske/ISO-tidsstempler

Hvis du har brug for lokal tid, skal du konvertere den nedstrøms ved hjælp af den kendte tidszone.

## Relaterede dokumenter

- [System Prompt](/concepts/system-prompt)
- [Tidszoner](/concepts/timezone)
- [Beskeder](/concepts/messages)
