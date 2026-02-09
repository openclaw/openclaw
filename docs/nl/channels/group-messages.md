---
summary: "Gedrag en configuratie voor het afhandelen van WhatsApp-groepsberichten (mentionPatterns worden gedeeld over surfaces)"
read_when:
  - Groepsberichtregels of mentions wijzigen
title: "Groepsberichten"
---

# Groepsberichten (WhatsApp web-kanaal)

Doel: Clawd in WhatsApp-groepen laten meedraaien, alleen wakker laten worden wanneer hij wordt gepingd, en die thread gescheiden houden van de persoonlijke DM-sessie.

Let op: `agents.list[].groupChat.mentionPatterns` wordt nu ook gebruikt door Telegram/Discord/Slack/iMessage; dit document richt zich op WhatsApp-specifiek gedrag. Voor multi-agentopstellingen stel je `agents.list[].groupChat.mentionPatterns` per agent in (of gebruik `messages.groupChat.mentionPatterns` als globale fallback).

## Wat is geïmplementeerd (2025-12-03)

- Activeringsmodi: `mention` (standaard) of `always`. `mention` vereist een ping (echte WhatsApp-@-mentions via `mentionedJids`, regexpatronen of het E.164-nummer van de bot ergens in de tekst). `always` wekt de agent bij elk bericht, maar hij zou alleen moeten antwoorden wanneer hij zinvolle waarde kan toevoegen; anders retourneert hij het stille token `NO_REPLY`. Standaarden kunnen in de config worden ingesteld (`channels.whatsapp.groups`) en per groep worden overschreven via `/activation`. Wanneer `channels.whatsapp.groups` is ingesteld, fungeert dit ook als groeps-allowlist (neem `"*"` op om alles toe te staan).
- Groepsbeleid: `channels.whatsapp.groupPolicy` bepaalt of groepsberichten worden geaccepteerd (`open|disabled|allowlist`). `allowlist` gebruikt `channels.whatsapp.groupAllowFrom` (fallback: expliciete `channels.whatsapp.allowFrom`). Standaard is `allowlist` (geblokkeerd totdat je afzenders toevoegt).
- Per-groepssessies: sessiesleutels zien eruit als `agent:<agentId>:whatsapp:group:<jid>`, zodat opdrachten zoals `/verbose on` of `/think high` (verstuurd als losse berichten) tot die groep zijn beperkt; de persoonlijke DM-status blijft onaangeroerd. Heartbeat-signalen worden overgeslagen voor groepsthreads.
- Contextinjectie: **alleen-wachtende** groepsberichten (standaard 50) die _geen_ run hebben getriggerd, worden voorafgegaan onder `[Chat messages since your last reply - for context]`, met de triggerende regel onder `[Current message - respond to this]`. Berichten die al in de sessie zitten, worden niet opnieuw geïnjecteerd.
- Afzenderweergave: elke groepsbatch eindigt nu met `[from: Sender Name (+E164)]` zodat Pi weet wie er spreekt.
- Ephemeral/view-once: deze worden uitgepakt vóór het extraheren van tekst/mentions, zodat pings daarin alsnog triggeren.
- Groepssysteemprompt: bij de eerste beurt van een groepssessie (en telkens wanneer `/activation` de modus wijzigt) injecteren we een korte tekst in de systeemprompt zoals `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Als metadata niet beschikbaar is, laten we de agent alsnog weten dat het om een groepschat gaat.

## Config-voorbeeld (WhatsApp)

Voeg een `groupChat`-blok toe aan `~/.openclaw/openclaw.json` zodat pings op weergavenaam werken, zelfs wanneer WhatsApp de visuele `@` uit de tekstbody verwijdert:

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

Notities:

- De regexen zijn hoofdletterongevoelig; ze dekken een ping op weergavenaam zoals `@openclaw` en het ruwe nummer met of zonder `+`/spaties.
- WhatsApp verstuurt nog steeds canonieke mentions via `mentionedJids` wanneer iemand op het contact tikt, dus de nummerfallback is zelden nodig maar wel een nuttig vangnet.

### Activatieopdracht (alleen eigenaar)

Gebruik de groepschatopdracht:

- `/activation mention`
- `/activation always`

Alleen het eigenaarsnummer (uit `channels.whatsapp.allowFrom`, of het E.164-nummer van de bot wanneer niet ingesteld) kan dit wijzigen. Stuur `/status` als los bericht in de groep om de huidige activeringsmodus te zien.

## Gebruik

1. Voeg je WhatsApp-account (degene die OpenClaw draait) toe aan de groep.
2. Zeg `@openclaw …` (of neem het nummer op). Alleen geautoriseerde afzenders kunnen dit triggeren, tenzij je `groupPolicy: "open"` instelt.
3. De agentprompt bevat recente groepscontext plus de afsluitende `[from: …]`-markering zodat hij de juiste persoon kan aanspreken.
4. Richtlijnen op sessieniveau (`/verbose on`, `/think high`, `/new` of `/reset`, `/compact`) gelden alleen voor de sessie van die groep; stuur ze als losse berichten zodat ze worden geregistreerd. Je persoonlijke DM-sessie blijft onafhankelijk.

## Testen / verificatie

- Handmatige smoke-test:
  - Stuur een `@openclaw`-ping in de groep en bevestig een antwoord dat naar de afzendernaam verwijst.
  - Stuur een tweede ping en verifieer dat het geschiedenisblok is opgenomen en vervolgens bij de volgende beurt wordt gewist.
- Controleer gateway-logs (start met `--verbose`) om `inbound web message`-items te zien die `from: <groupJid>` en het `[from: …]`-achtervoegsel tonen.

## Bekende aandachtspunten

- Heartbeat-signalen worden bewust overgeslagen voor groepen om luidruchtige broadcasts te vermijden.
- Echo-onderdrukking gebruikt de gecombineerde batchstring; als je identieke tekst twee keer verstuurt zonder mentions, krijgt alleen de eerste een reactie.
- Sessiestore-items verschijnen als `agent:<agentId>:whatsapp:group:<jid>` in de sessiestore (`~/.openclaw/agents/<agentId>/sessions/sessions.json` standaard); een ontbrekend item betekent simpelweg dat de groep nog geen run heeft getriggerd.
- Typindicatoren in groepen volgen `agents.defaults.typingMode` (standaard: `message` wanneer niet genoemd).
