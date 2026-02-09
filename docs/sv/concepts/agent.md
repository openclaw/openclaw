---
summary: "Agentkörning (inbäddad pi-mono), arbetsyteavtal och sessionsbootstrap"
read_when:
  - Vid ändring av agentkörning, bootstrap av arbetsyta eller sessionsbeteende
title: "Agentkörning"
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

Tomma filer hoppas över. Stora filer trimmas och trunkeras med en markör så att uppmaningarna förblir magra (läs filen för hela innehållet).

Om en fil saknas injicerar OpenClaw en enda rad med markören ”saknad fil” (och `openclaw setup` skapar en säker standardmall).

`BOOTSTRAP.md` skapas endast för en **helt ny arbetsyta** (inga andra bootstrap-filer närvarande). Om du tar bort det efter avslutad ritual, bör det inte återskapas vid senare omstart.

För att helt inaktivera skapandet av bootstrap-filer (för försådda arbetsytor), sätt:

```json5
{ agent: { skipBootstrap: true } }
```

## Inbyggda verktyg

Kärnverktyg (läs-/exekvera/redigera/skriva och relaterade systemverktyg) är alltid tillgängliga,
med förbehåll för verktygspolicy. `apply_patch` är valfritt och gated av
`tools.exec.applyPatch`. `TOOLS.md` kontrollerar **inte** vilka verktyg som finns; det är
vägledning för hur _you_ vill att de används.

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

Sessions-ID är stabilt och valt av OpenClaw.
Äldre Pi/Tau sessionsmappar är **inte** lästa.

## Styrning under strömning

När köläget är `steer`, injiceras inkommande meddelanden i den aktuella körningen.
Kön kontrolleras **efter varje verktygssamtal**; om ett köat meddelande finns
återstående verktygssamtal från det aktuella assistentmeddelandet hoppas över (felverktyget
resultat med "Hoppas över på grund av köat användarmeddelande. ), sedan den köade användaren
meddelande injiceras innan nästa assistent svar.

När köläget är `followup` eller `collect`, hålls inkommande meddelanden tills
nuvarande turn slutar, sedan börjar en ny agent vända med köade nyttolaster. Se
[Queue](/concepts/queue) för läge + debounce/cap-beteende.

Blockstreaming skickar slutförda blockeringar så snart de är färdiga; det är
**av som standard** (`agents.defaults.blockStreamingDefault: "off"`).
Justera gränsen via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; standard är text_end).
Kontrollera soft block chunking med `agents.defaults.blockStreamingChunk` (standard är
800–1200 tecken; föredrar paragraf bryts och sedan newlines; meningar sista).
Coalesce strömmade bitar med `agents.defaults.blockStreamingCoalesce` för att minska
enkelraders skräppost (inaktiv sammanslagning innan sändning). Icke-Telegram kanaler kräver
explicit `*.blockStreaming: true` för att aktivera blocksvar.
Verbose verktygssammanfattningar släpps ut vid verktygsstart (ingen debounce); Kontroll UI
strömmar verktygsutgång via agenthändelser när det är tillgängligt.
Fler detaljer: [Streaming + chunking](/concepts/streaming).

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
