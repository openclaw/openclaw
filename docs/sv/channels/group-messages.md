---
summary: "”Beteende och konfig för hantering av WhatsApp-gruppmeddelanden (mentionPatterns delas över ytor)”"
read_when:
  - Ändrar regler för gruppmeddelanden eller omnämnanden
title: "”Gruppmeddelanden”"
---

# Gruppmeddelanden (WhatsApp web channel)

Mål: låta Clawd sitta i WhatsApp-grupper, vakna bara när den pingas och hålla den tråden separat från den personliga DM-sessionen.

Obs: `agents.list[].groupChat.mentionPatterns` används nu av Telegram/Discord/Slack/iMessage också; detta dokument fokuserar på WhatsApp-specifikt beteende. För multi-agent inställningar, sätt `agents.list[].groupChat.mentionPatterns` per agent (eller använd `messages.groupChat.mentionPatterns` som en global reserv).

## Vad som är implementerat (2025-12-03)

- Aktiveringslägen: `mention` (standard) eller `alltid`. `nämna` kräver en ping (riktig WhatsApp @-nämner via `nämnedJids`, regex mönster, eller botens E.164 var som helst i texten). `alltid` väcker agenten på varje meddelande men det bör bara svara när det kan addera meningsfullt värde; annars returnerar det tysta token `NO_REPLY`. Standardvärden kan ställas in i konfigurationen (`channels.whatsapp.groups`) och åsidosättas per grupp via `/activation`. När `channels.whatsapp.groups` är satt, fungerar det också som en grupptillåten lista (inkludera `"*"` för att tillåta alla).
- Grupppolicy: `channels.whatsapp.groupPolicy` kontrollerar om gruppmeddelanden accepteras (`open<unk> disabled<unk> allowlist`). `allowlist` använder `channels.whatsapp.groupAllowFrom` (fallback: explicit `channels.whatsapp.allowFrom`). Standard är `allowlist` (blockerad tills du lägger till avsändare).
- Sessioner per grupp: sessionsnycklar ser ut som `agent:<agentId>:whatsapp:group:<jid>` så kommandon som `/verbose on` eller `/think high` (skickas som fristående meddelanden) är begränsade till den gruppen; Personligt DM-tillstånd är orört. Hjärtslag hoppas över för grupptrådar.
- Kontextinjektion: **väntandebara** gruppmeddelanden (standard 50) som _inte aktiverade en körning är prefixade under `[Chattmeddelanden sedan ditt senaste svar - för sammanhang]`, med den utlösande raden under `[Aktuellt meddelande - svara på detta]`. Meddelanden som redan finns i sessionen återinjiceras.
- Avsändarsynlighet: varje gruppbatch avslutas nu med `[from: Sender Name (+E164)]` så att Pi vet vem som talar.
- Försvinnande/view-once: dessa packas upp innan text/omnämnanden extraheras, så pingar i dem triggar fortfarande.
- Gruppsystemprompt: vid första vändningen av en gruppsession (och när `/activation` ändrar läget) injicerar vi en kort blurb i systemprompten som `Du svarar inuti WhatsApp-gruppen "<subject>". Gruppmedlemmar: Alice (+44...), Bob (+43...), … Aktivering: Endast trigger- … Adress till den specifika avsändare som noteras i meddelandekontexten.` Om metadata inte är tillgängligt berättar vi fortfarande för agenten att det är en gruppchatt.

## Konfigexempel (WhatsApp)

Lägg till ett `groupChat`‑block i `~/.openclaw/openclaw.json` så att pingar via visningsnamn fungerar även när WhatsApp tar bort den visuella `@` i textkroppen:

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

Noteringar:

- Regexarna är skiftlägesokänsliga; de täcker en ping med visningsnamn som `@openclaw` samt det råa numret med eller utan `+`/mellanslag.
- WhatsApp skickar fortfarande kanoniska omnämnanden via `mentionedJids` när någon trycker på kontakten, så nummer‑reserv behövs sällan men är ett användbart säkerhetsnät.

### Aktiveringskommando (endast ägare)

Använd gruppchattkommandot:

- `/activation mention`
- `/activation always`

Endast ägarnumret (från `channels.whatsapp.allowFrom`, eller botens egna E.164 vid uppackning) kan ändra detta. Skicka `/status` som ett fristående meddelande i gruppen för att se aktuellt aktiveringsläge.

## Hur man använder

1. Lägg till ditt WhatsApp‑konto (det som kör OpenClaw) i gruppen.
2. Säg `@openclaw …` (eller inkludera nummer). Endast tillåtna avsändare kan utlösa det såvida du inte anger `groupPolicy: "open"`.
3. Agentprompten kommer att inkludera nylig gruppkontext plus den avslutande `[from: …]`‑markören så att den kan adressera rätt person.
4. Sessionsnivådirektiv (`/verbose on`, `/think high`, `/new` eller `/reset`, `/compact`) gäller endast den gruppens session; skicka dem som fristående meddelanden så att de registrerar. Din personliga DM-session förblir oberoende.

## Testning / verifiering

- Manuell smoke:
  - Skicka en `@openclaw`‑ping i gruppen och bekräfta ett svar som refererar till avsändarnamnet.
  - Skicka en andra ping och verifiera att historikblocket inkluderas och sedan rensas vid nästa tur.
- Kontrollera gateway‑loggar (kör med `--verbose`) för att se `inbound web message`‑poster som visar `from: <groupJid>` och suffixet `[from: …]`.

## Kända överväganden

- Heartbeats hoppas avsiktligt över för grupper för att undvika bullriga utskick.
- Eko‑undertryckning använder den kombinerade batchsträngen; om du skickar identisk text två gånger utan omnämnanden får bara den första ett svar.
- Poster i sessionslagret kommer att visas som `agent:<agentId>:whatsapp:group:<jid>` i sessionslagret (`~/.openclaw/agents/<agentId>/sessions/sessions.json` som standard); en saknad post betyder bara att gruppen inte har triggat en körning ännu.
- Skrivindikatorer i grupper följer `agents.defaults.typingMode` (standard: `message` när den inte är omnämnd).
