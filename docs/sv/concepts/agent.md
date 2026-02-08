---
summary: "Agentkörning (inbäddad pi-mono), arbetsyteavtal och sessionsbootstrap"
read_when:
  - Vid ändring av agentkörning, bootstrap av arbetsyta eller sessionsbeteende
title: "Agentkörning"
x-i18n:
  source_path: concepts/agent.md
  source_hash: 121103fda29a5481
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:03Z
---

# Agentkörning 🤖

OpenClaw kör en enda inbäddad agentkörning som härstammar från **pi-mono**.

## Arbetsyta (krävs)

OpenClaw använder en enda agentarbetsytekatalog (`agents.defaults.workspace`) som agentens **enda** arbetskatalog (`cwd`) för verktyg och kontext.

Rekommenderat: använd `openclaw setup` för att skapa `~/.openclaw/openclaw.json` om den saknas och initiera arbetsytefilerna.

Fullständig arbetsytelayout + guide för säkerhetskopiering: [Agentarbetsyta](/concepts/agent-workspace)

Om `agents.defaults.sandbox` är aktiverat kan icke-huvudsessioner åsidosätta detta med
arbetsytor per session under `agents.defaults.sandbox.workspaceRoot` (se
[Gateway-konfiguration](/gateway/configuration)).

## Bootstrap-filer (injiceras)

Inuti `agents.defaults.workspace` förväntar sig OpenClaw dessa användarredigerbara filer:

- `AGENTS.md` — driftinstruktioner + ”minne”
- `SOUL.md` — persona, gränser, ton
- `TOOLS.md` — användarunderhållna verktygsanteckningar (t.ex. `imsg`, `sag`, konventioner)
- `BOOTSTRAP.md` — engångsritual vid första körning (tas bort efter slutförande)
- `IDENTITY.md` — agentnamn/vibe/emoji
- `USER.md` — användarprofil + föredragen tilltalsform

Vid första turen i en ny session injicerar OpenClaw innehållet i dessa filer direkt i agentens kontext.

Tomma filer hoppas över. Stora filer trimmas och trunkeras med en markör så att promptar hålls smidiga (läs filen för fullständigt innehåll).

Om en fil saknas injicerar OpenClaw en enda rad med markören ”saknad fil” (och `openclaw setup` skapar en säker standardmall).

`BOOTSTRAP.md` skapas endast för en **helt ny arbetsyta** (inga andra bootstrap-filer finns). Om du tar bort den efter att ritualen slutförts ska den inte återskapas vid senare omstarter.

För att helt inaktivera skapandet av bootstrap-filer (för försådda arbetsytor), sätt:

```json5
{ agent: { skipBootstrap: true } }
```

## Inbyggda verktyg

Kärnverktyg (read/exec/edit/write och relaterade systemverktyg) är alltid tillgängliga,
med förbehåll för verktygspolicy. `apply_patch` är valfritt och styrs av
`tools.exec.applyPatch`. `TOOLS.md` styr **inte** vilka verktyg som finns; det är
vägledning för hur _du_ vill att de ska användas.

## Skills

OpenClaw laddar Skills från tre platser (arbetsytan vinner vid namnkonflikt):

- Buntade (levereras med installationen)
- Hanterade/lokala: `~/.openclaw/skills`
- Arbetsyta: `<workspace>/skills`

Skills kan styras via konfig/miljövariabler (se `skills` i [Gateway-konfiguration](/gateway/configuration)).

## pi-mono-integration

OpenClaw återanvänder delar av pi-mono-kodbasen (modeller/verktyg), men **sessionshantering, Discovery och verktygskoppling ägs av OpenClaw**.

- Ingen pi-coding-agentkörning.
- Inga inställningar för `~/.pi/agent` eller `<workspace>/.pi` används.

## Sessioner

Sessionsutskrifter lagras som JSONL på:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

Sessions-ID:t är stabilt och väljs av OpenClaw.
Äldre Pi/Tau-sessionsmappar läses **inte**.

## Styrning under strömning

När köläget är `steer` injiceras inkommande meddelanden i den pågående körningen.
Kön kontrolleras **efter varje verktygsanrop**; om ett köat meddelande finns,
hoppas återstående verktygsanrop från det aktuella assistentmeddelandet över (felaktiga verktygsresultat med ”Skipped due to queued user message.”), och därefter injiceras det köade användarmeddelandet före nästa assistentsvar.

När köläget är `followup` eller `collect` hålls inkommande meddelanden tills den
aktuella turen avslutas, och därefter startar en ny agenttur med de köade nyttolasterna. Se
[Kö](/concepts/queue) för lägen samt debounce-/kapacitetsbeteende.

Blockstreaming skickar färdiga assistentblock så snart de är klara; det är
**avstängt som standard** (`agents.defaults.blockStreamingDefault: "off"`).
Justera gränsen via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; standard är text_end).
Styr mjuk blockindelning med `agents.defaults.blockStreamingChunk` (standard
800–1200 tecken; föredrar styckebrytningar, sedan radbrytningar; meningar sist).
Sammanfoga strömmade delar med `agents.defaults.blockStreamingCoalesce` för att minska
enradsskräp (sammanslagning baserad på inaktivitet före sändning). Kanaler som inte är Telegram kräver
explicit `*.blockStreaming: true` för att aktivera blocksvar.
Utförliga verktygssammanfattningar skickas vid verktygsstart (ingen debounce); Control UI
strömmar verktygsutdata via agenthändelser när det finns tillgängligt.
Mer detaljer: [Strömning + chunking](/concepts/streaming).

## Modellreferenser

Modellreferenser i konfig (till exempel `agents.defaults.model` och `agents.defaults.models`) tolkas genom att delas vid den **första** `/`.

- Använd `provider/model` när du konfigurerar modeller.
- Om själva modell-ID:t innehåller `/` (OpenRouter-stil), inkludera leverantörsprefixet (exempel: `openrouter/moonshotai/kimi-k2`).
- Om du utelämnar leverantören behandlar OpenClaw inmatningen som ett alias eller en modell för **standardleverantören** (fungerar endast när det inte finns någon `/` i modell-ID:t).

## Konfiguration (minimalt)

Som minimum, sätt:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (starkt rekommenderat)

---

_Nästa: [Gruppchattar](/channels/group-messages)_ 🦞
