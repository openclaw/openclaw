---
summary: ”Beteende och konfig för hantering av WhatsApp-gruppmeddelanden (mentionPatterns delas över ytor)”
read_when:
  - Ändrar regler för gruppmeddelanden eller omnämnanden
title: ”Gruppmeddelanden”
x-i18n:
  source_path: channels/group-messages.md
  source_hash: 181a72f12f5021af
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:19Z
---

# Gruppmeddelanden (WhatsApp web channel)

Mål: låta Clawd sitta i WhatsApp-grupper, vakna bara när den pingas och hålla den tråden separat från den personliga DM-sessionen.

Obs: `agents.list[].groupChat.mentionPatterns` används nu även av Telegram/Discord/Slack/iMessage; detta dokument fokuserar på WhatsApp-specifikt beteende. För multi-agent-uppsättningar, sätt `agents.list[].groupChat.mentionPatterns` per agent (eller använd `messages.groupChat.mentionPatterns` som global reserv).

## Vad som är implementerat (2025-12-03)

- Aktiveringslägen: `mention` (standard) eller `always`. `mention` kräver en ping (riktiga WhatsApp-@-omnämnanden via `mentionedJids`, regexmönster eller botens E.164 var som helst i texten). `always` väcker agenten på varje meddelande men den ska bara svara när den kan tillföra meningsfullt värde; annars returnerar den den tysta token `NO_REPLY`. Standarder kan sättas i konfig (`channels.whatsapp.groups`) och åsidosättas per grupp via `/activation`. När `channels.whatsapp.groups` är satt fungerar den också som en grupp‑tillåtelselista (inkludera `"*"` för att tillåta alla).
- Gruppolicy: `channels.whatsapp.groupPolicy` styr om gruppmeddelanden accepteras (`open|disabled|allowlist`). `allowlist` använder `channels.whatsapp.groupAllowFrom` (reserv: explicit `channels.whatsapp.allowFrom`). Standard är `allowlist` (blockerat tills du lägger till avsändare).
- Sessioner per grupp: sessionsnycklar ser ut som `agent:<agentId>:whatsapp:group:<jid>` så kommandon som `/verbose on` eller `/think high` (skickade som fristående meddelanden) är avgränsade till den gruppen; personlig DM‑status berörs inte. Heartbeats hoppas över för grupptrådar.
- Kontextinjektion: **endast väntande** gruppmeddelanden (standard 50) som _inte_ triggade en körning prefixas under `[Chat messages since your last reply - for context]`, med den utlösande raden under `[Current message - respond to this]`. Meddelanden som redan finns i sessionen injiceras inte igen.
- Avsändarsynlighet: varje gruppbatch avslutas nu med `[from: Sender Name (+E164)]` så att Pi vet vem som talar.
- Försvinnande/view-once: dessa packas upp innan text/omnämnanden extraheras, så pingar i dem triggar fortfarande.
- Gruppsystemprompt: vid första turen i en gruppsession (och när `/activation` ändrar läget) injicerar vi en kort text i systemprompten som `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Om metadata inte är tillgänglig talar vi ändå om för agenten att det är en gruppchatt.

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

Endast ägarnumret (från `channels.whatsapp.allowFrom`, eller botens egen E.164 när den är osatt) kan ändra detta. Skicka `/status` som ett fristående meddelande i gruppen för att se aktuellt aktiveringsläge.

## Hur man använder

1. Lägg till ditt WhatsApp‑konto (det som kör OpenClaw) i gruppen.
2. Säg `@openclaw …` (eller inkludera numret). Endast tillåtelseliste‑avsändare kan trigga den om du inte sätter `groupPolicy: "open"`.
3. Agentprompten kommer att inkludera nylig gruppkontext plus den avslutande `[from: …]`‑markören så att den kan adressera rätt person.
4. Direktiven på sessionsnivå (`/verbose on`, `/think high`, `/new` eller `/reset`, `/compact`) gäller endast den gruppens session; skicka dem som fristående meddelanden så att de registreras. Din personliga DM‑session förblir oberoende.

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
