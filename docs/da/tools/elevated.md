---
summary: "Forhøjet exec-tilstand og /elevated-direktiver"
read_when:
  - Justering af standarder for forhøjet tilstand, tilladelseslister eller slash-kommandoers adfærd
title: "Forhøjet tilstand"
---

# Forhøjet tilstand (/elevated-direktiver)

## Hvad den gør

- `/elevated on` kører på gateway-værten og bevarer exec-godkendelser (samme som `/elevated ask`).
- `/elevated full` kører på gateway-værten **og** auto-godkender exec (springer exec-godkendelser over).
- `/elevated ask` kører på gateway-værten men bevarer exec-godkendelser (samme som `/elevated on`).
- `on`/`ask` gennemtvinger **ikke** `exec.security=full`; konfigureret sikkerheds-/ask-politik gælder stadig.
- Ændrer kun adfærd, når agenten er **sandboxed** (ellers kører exec allerede på værten).
- Direktiveformer: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Kun `on|off|ask|full` accepteres; alt andet returnerer et hint og ændrer ikke tilstand.

## Hvad den styrer (og hvad den ikke gør)

- **Tilgængelighed gates**: `tools.elevated` er den globale baseline. `agents.list[].tools.elevated` kan yderligere begrænse forhøjet per agent (begge skal tillade).
- **Per-session-tilstand**: `/elevated on|off|ask|full` sætter det forhøjede niveau for den aktuelle sessionsnøgle.
- **Indlejret direktiv**: `/elevated on|ask|full` inde i en besked gælder kun for den besked.
- **Grupper**: I gruppechats er forhøjede direktiver kun hædret når agenten er nævnt. Kommando-kun meddelelser, der omgår nævne krav behandles som nævnt.
- **Udførsel på værten**: forhøjet gennemtvinger `exec` på gateway-værten; `full` sætter også `security=full`.
- **Godkendelser**: `full` springer exec-godkendelser over; `on`/`ask` respekterer dem, når tilladelsesliste-/ask-regler kræver det.
- **Ikke-sandboxede agenter**: no-op for placering; påvirker kun gating, logning og status.
- **Værktøjspolitik gælder stadig**: hvis `exec` er afvist af værktøjspolitikken, kan forhøjet ikke bruges.
- **Adskilt fra `/exec`**: `/exec` justerer per-session-standarder for autoriserede afsendere og kræver ikke forhøjet.

## Opløsningsrækkefølge

1. Indlejret direktiv i beskeden (gælder kun for den besked).
2. Sessions-override (sat ved at sende en besked, der kun er et direktiv).
3. Global standard (`agents.defaults.elevatedDefault` i konfiguration).

## Sæt en sessionsstandard

- Send en besked, der er **kun** direktivet (blanke tegn tilladt), fx `/forhøjet full`.
- Der sendes et bekræftelsessvar (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Hvis forhøjet adgang er deaktiveret, eller afsenderen ikke er på den godkendte tilladelsesliste, svarer direktivet med en handlingsbar fejl og ændrer ikke sessionstilstanden.
- Send `/elevated` (eller `/elevated:`) uden argument for at se det aktuelle forhøjede niveau.

## Tilgængelighed + tilladelseslister

- Funktionsgate: `tools.elevated.enabled` (standard kan være slået fra via konfiguration, selv hvis koden understøtter det).
- Afsenderen tillader: `tools.elevated.allowFrom` med per-provider tilladelseslister (f.eks. `discord`, `whatsapp`).
- Per-agent-gate: `agents.list[].tools.elevated.enabled` (valgfri; kan kun yderligere begrænse).
- Per-agent-tilladelsesliste: `agents.list[].tools.elevated.allowFrom` (valgfri; når den er sat, skal afsenderen matche **både** globale + per-agent-tilladelseslister).
- Discord fallback: if `tools.elevated.allowFrom.discord` is omitted, the `channels.discord.dm.allowFrom` list is used as a fallback. Sæt `tools.elevated.allowFrom.discord` (selv `[]`) til at tilsidesætte. Per-agent allowlists gør **ikke** brug faldet.
- Alle gates skal passere; ellers behandles forhøjet som utilgængeligt.

## Logning + status

- Forhøjede exec-kald logges på info-niveau.
- Sessionsstatus omfatter forhøjet tilstand (f.eks. `elevated=ask`, `elevated=full`).
