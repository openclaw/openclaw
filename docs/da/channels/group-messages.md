---
summary: "Adfærd og konfiguration for håndtering af WhatsApp-gruppemeddelelser (mentionPatterns deles på tværs af flader)"
read_when:
  - Ændring af regler for gruppemeddelelser eller omtaler
title: "Gruppemeddelelser"
x-i18n:
  source_path: channels/group-messages.md
  source_hash: 181a72f12f5021af
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:58Z
---

# Gruppemeddelelser (WhatsApp web-kanal)

Mål: lade Clawd sidde i WhatsApp-grupper, vågne kun når den bliver pinget og holde den tråd adskilt fra den personlige DM-session.

Bemærk: `agents.list[].groupChat.mentionPatterns` bruges nu også af Telegram/Discord/Slack/iMessage; dette dokument fokuserer på WhatsApp-specifik adfærd. For multi-agent-opsætninger skal du sætte `agents.list[].groupChat.mentionPatterns` pr. agent (eller bruge `messages.groupChat.mentionPatterns` som global fallback).

## Hvad er implementeret (2025-12-03)

- Aktiveringstilstande: `mention` (standard) eller `always`. `mention` kræver et ping (ægte WhatsApp @-omtaler via `mentionedJids`, regex-mønstre eller bot’ens E.164 et vilkårligt sted i teksten). `always` vækker agenten ved hver besked, men den bør kun svare, når den kan tilføre meningsfuld værdi; ellers returnerer den den tavse token `NO_REPLY`. Standarder kan sættes i konfigurationen (`channels.whatsapp.groups`) og tilsidesættes pr. gruppe via `/activation`. Når `channels.whatsapp.groups` er sat, fungerer den også som en gruppe-tilladelsesliste (inkludér `"*"` for at tillade alle).
- Gruppepolitik: `channels.whatsapp.groupPolicy` styrer, om gruppemeddelelser accepteres (`open|disabled|allowlist`). `allowlist` bruger `channels.whatsapp.groupAllowFrom` (fallback: eksplicit `channels.whatsapp.allowFrom`). Standard er `allowlist` (blokeret, indtil du tilføjer afsendere).
- Sessioner pr. gruppe: sessionsnøgler ser ud som `agent:<agentId>:whatsapp:group:<jid>`, så kommandoer som `/verbose on` eller `/think high` (sendt som selvstændige beskeder) er afgrænset til den gruppe; personlig DM-tilstand berøres ikke. Heartbeats springes over for gruppetråde.
- Kontekstindsprøjtning: **kun-afventende** gruppemeddelelser (standard 50), der _ikke_ udløste et run, præfikseres under `[Chat messages since your last reply - for context]`, med den udløsende linje under `[Current message - respond to this]`. Beskeder, der allerede er i sessionen, genindsprøjtes ikke.
- Afsendersynlighed: hver gruppebatch slutter nu med `[from: Sender Name (+E164)]`, så Pi ved, hvem der taler.
- Flygtige/view-once: disse pakkes ud, før tekst/omtaler udtrækkes, så ping inde i dem stadig udløser.
- Gruppesystemprompt: ved første tur i en gruppesession (og når `/activation` ændrer tilstand) indsætter vi en kort tekst i systemprompten som `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Hvis metadata ikke er tilgængelige, fortæller vi stadig agenten, at det er en gruppechat.

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

Kun ejernummeret (fra `channels.whatsapp.allowFrom`, eller bot’ens egen E.164 når den ikke er sat) kan ændre dette. Send `/status` som en selvstændig besked i gruppen for at se den aktuelle aktiveringstilstand.

## Sådan bruges det

1. Tilføj din WhatsApp-konto (den der kører OpenClaw) til gruppen.
2. Sig `@openclaw …` (eller inkludér nummeret). Kun tilladelseslistede afsendere kan udløse den, medmindre du sætter `groupPolicy: "open"`.
3. Agentprompten vil inkludere nylig gruppekontekst plus den afsluttende `[from: …]`-markør, så den kan henvende sig til den rette person.
4. Direktiver på sessionsniveau (`/verbose on`, `/think high`, `/new` eller `/reset`, `/compact`) gælder kun for den gruppes session; send dem som selvstændige beskeder, så de registreres. Din personlige DM-session forbliver uafhængig.

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
