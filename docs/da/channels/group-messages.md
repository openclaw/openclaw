---
summary: "Adfærd og konfiguration for håndtering af WhatsApp-gruppemeddelelser (mentionPatterns deles på tværs af flader)"
read_when:
  - Ændring af regler for gruppemeddelelser eller omtaler
title: "Gruppemeddelelser"
---

# Gruppemeddelelser (WhatsApp web-kanal)

Mål: lade Clawd sidde i WhatsApp-grupper, vågne kun når den bliver pinget og holde den tråd adskilt fra den personlige DM-session.

Bemærk: `agents.list[].groupChat.mentionPatterns` bruges nu af Telegram/Discord/Slack/iMessage også; dette dokument fokuserer på WhatsApp-specifik opførsel. For multi-agent opsætninger, sæt `agents.list[].groupChat.mentionPatterns` per agent (eller brug `messages.groupChat.mentionPatterns` som en global fallback).

## Hvad er implementeret (2025-12-03)

- Aktiveringstilstande: `mention` (standard) eller `altid`. `mention` kræver en ping (ægte WhatsApp @-nævner via `nævnteJids`, regex mønstre, eller bot’s E.164 hvor som helst i teksten). `always` vækker agenten på alle meddelelser, men det bør kun svare, når det kan tilføje meningsfuld værdi; ellers returnerer det tavse token `NO_REPLY`. Standarder kan indstilles i config (`channels.whatsapp.groups`) og tilsidesættes pr. gruppe via `/activation`. Når `channels.whatsapp.groups` er indstillet, fungerer det også som en gruppe tilladt liste (omfatter `"*"` for at tillade alle).
- Gruppepolitik: `channels.whatsapp.groupPolicy` styrer om gruppemeddelelser er accepteret (`open- disabled- allowlist`). `allowlist` bruger `channels.whatsapp.groupAllowFrom` (fallback: explicit `channels.whatsapp.allowFrom`). Standard er `allowlist` (blokeret indtil du tilføjer afsendere).
- Per-group sessioner: session nøgler ser ud som `agent:<agentId>:whatsapp:group:<jid>` så kommandoer såsom `/verbose on` eller `/think high` (sendt som enkeltstående beskeder) er scoped til denne gruppe personlig DM stat er uberørt. Hjertebanken springes over for gruppetråde.
- Kontekstinjektion: **Afventende kun** gruppebeskeder (standard 50) som _did not_ udløser et løb er forudfikseret under `[Chat beskeder siden dit sidste svar - for context]`, med den udløsende linje under `[Nuværende meddelelse - svar på denne]`. Meddelelser, der allerede er i sessionen, bliver ikke geninjiceret.
- Afsendersynlighed: hver gruppebatch slutter nu med `[from: Sender Name (+E164)]`, så Pi ved, hvem der taler.
- Flygtige/view-once: disse pakkes ud, før tekst/omtaler udtrækkes, så ping inde i dem stadig udløser.
- Gruppesystem prompt: ved første omgang af en gruppesession (og når `/aktivering` ændrer tilstanden) indsætter vi en kort slurb i systemprompten som `Du svarer inde i WhatsApp gruppen "<subject>". Gruppemedlemmer: Alice (+44...), Bob (+43...), … Aktivering: kun udløser … Adresse den specifikke afsender bemærket i meddelelsessammenhængen.` Hvis metadata ikke er tilgængelige, vi stadig fortælle agenten det er en gruppe chat.

## Konfigurationseksempel (WhatsApp)

Tilføj en `groupChat`-blok til `~/.openclaw/openclaw.json`, så ping på visningsnavn virker, selv når WhatsApp fjerner den visuelle `@` i tekstindholdet:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Noter:

- Regex’erne er ikke-følsomme for store/små bogstaver; de dækker et ping på visningsnavn som `@openclaw` og det rå nummer med eller uden `+`/mellemrum.
- WhatsApp sender stadig kanoniske omtaler via `mentionedJids`, når nogen trykker på kontakten, så nummer-fallbacken er sjældent nødvendig, men er et nyttigt sikkerhedsnet.

### Aktiveringskommando (kun ejer)

Brug gruppechat-kommandoen:

- `/activation mention`
- `/activation always`

Kun ejeren nummer (fra `channels.whatsapp.allowFrom`, eller bot’s egen E.164 når frakoblet) kan ændre dette. Send `/status` som en selvstændig besked i gruppen for at se den aktuelle aktiveringstilstand.

## Sådan bruges det

1. Tilføj din WhatsApp-konto (den der kører OpenClaw) til gruppen.
2. Sig `@openclaw …` (eller inkludere nummeret). Kun tilladte afsendere kan udløse det, medmindre du sætter `groupPolicy: "open"`.
3. Agentprompten vil inkludere nylig gruppekontekst plus den afsluttende `[from: …]`-markør, så den kan henvende sig til den rette person.
4. Direktiver på sessionsniveau (`/verbose on`, `/think high`, `/new` eller `/reset`, `/compact`) gælder kun for den pågældende gruppes session; sender dem som enkeltstående meddelelser, så de registreres. Din personlige DM session forbliver uafhængig.

## Test / verifikation

- Manuel smoke-test:
  - Send et `@openclaw`-ping i gruppen og bekræft et svar, der refererer til afsenderens navn.
  - Send et andet ping og verificér, at historikblokken inkluderes og derefter ryddes ved næste tur.
- Tjek gateway-logs (kør med `--verbose`) for at se `inbound web message`-poster, der viser `from: <groupJid>` og `[from: …]`-suffikset.

## Kendte overvejelser

- Heartbeats springes bevidst over for grupper for at undgå støjende udsendelser.
- Ekko-undertrykkelse bruger den samlede batch-streng; hvis du sender identisk tekst to gange uden omtaler, får kun den første et svar.
- Session store-poster vil fremstå som `agent:<agentId>:whatsapp:group:<jid>` i session store (`~/.openclaw/agents/<agentId>/sessions/sessions.json` som standard); en manglende post betyder blot, at gruppen endnu ikke har udløst et run.
- Skriveindikatorer i grupper følger `agents.defaults.typingMode` (standard: `message` når der ikke er omtalt).
