---
summary: "Forskningsanteckningar: offline-minnessystem för Clawd-arbetsytor (Markdown som källa för sanningen + härlett index)"
read_when:
  - Utformning av arbetsyteminne (~/.openclaw/workspace) bortom dagliga Markdown-loggar
  - Deciding: fristående CLI vs djup OpenClaw integration
  - Tillägg av offline återkallelse + reflektion (retain/recall/reflect)
title: "Forskning om arbetsyteminne"
---

# Arbetsyteminne v2 (offline): forskningsanteckningar

Mål: Clawd-style arbetsyta (`agents.defaults.workspace`, standard `~/. penclaw/workspace`) där ”memory” lagras som en Markdown-fil per dag (`memory/YYYY-MM-DD.md`) plus en liten uppsättning stabila filer (t.ex. `memory.md`, `SOUL.md`).

Detta dokument föreslår en **offline-first**-minnesarkitektur som behåller Markdown som den kanoniska, granskbara källan för sanningen, men lägger till **strukturerad återkallelse** (sökning, entitetssammanfattningar, uppdatering av tillförlitlighet) via ett härlett index.

## Varför ändra?

Den nuvarande uppsättningen (en fil per dag) är utmärkt för:

- ”append-only”-journalföring
- mänsklig redigering
- git-backad hållbarhet + spårbarhet
- låg tröskel för insamling (”skriv bara ner det”)

Den är svag för:

- återhämtning med hög träffsäkerhet (”vad bestämde vi om X?”, ”senast vi provade Y?”)
- entitetscentrerade svar (”berätta om Alice / The Castle / warelay”) utan att läsa många filer
- stabilitet i åsikter/preferenser (och bevis när de ändras)
- tidsbegränsningar ("vad var sant under november 2025?") och konfliktlösning

## Designmål

- **Offline**: fungerar utan nätverk; kan köras på laptop/Castle; inget molnberoende.
- **Förklarbar**: hämtade objekt ska kunna härledas (fil + plats) och hållas isär från inferens.
- **Låg ceremoni**: daglig loggning förblir Markdown, inget tungt schemarbete.
- **Inkrementell**: v1 är användbar med enbart FTS; semantisk/vektor och grafer är valfria uppgraderingar.
- **Agentvänlig**: gör ”återkallelse inom tokenbudgetar” enkel (returnerar små buntar av fakta).

## North star-modell (Hindsight × Letta)

Två delar att blanda:

1. **Letta/MemGPT-stil kontrollloop**

- håll en liten ”kärna” alltid i kontext (persona + viktiga användarfakta)
- allt annat är utanför kontext och hämtas via verktyg
- minnesskrivningar är explicita verktygsanrop (append/replace/insert), persistenta och återinjiceras nästa tur

2. **Hindsight-stil minnessubstrat**

- separera vad som observeras vs vad som tros vs vad som sammanfattas
- stöd för retain/recall/reflect
- åsikter med tillförlitlighet som kan utvecklas med bevis
- entitetsmedveten återkallelse + temporala frågor (även utan fulla kunskapsgrafer)

## Föreslagen arkitektur (Markdown som källa för sanningen + härlett index)

### Kanonisk lagring (git-vänlig)

Behåll `~/.openclaw/workspace` som kanoniskt, människoläsbart minne.

Föreslagen arbetsytestruktur:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Noteringar:

- **Daglig logg stannar daglig loggen**. Inget behov av att förvandla det till JSON.
- Filerna `bank/` är **kuraterade**, producerade av reflektionsjobb, och kan fortfarande redigeras för hand.
- `memory.md` förblir ”liten + kärnlik”: det du vill att Clawd ska se varje session.

### Härledd lagring (maskinell återkallelse)

Lägg till ett härlett index under arbetsytan (inte nödvändigtvis git-spårat):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Backa det med:

- SQLite-schema för fakta + entitetslänkar + åsiktsmetadata
- SQLite **FTS5** för lexikal återkallelse (snabbt, litet, offline)
- valfri tabell med inbäddningar för semantisk återkallelse (fortfarande offline)

Indexet är alltid **återuppbyggbart från Markdown**.

## Retain / Recall / Reflect (operativ loop)

### Retain: normalisera dagliga loggar till ”fakta”

Hindsights centrala insikt som spelar roll här: lagra **narrativa, självständiga fakta**, inte små fragment.

Praktisk regel för `memory/YYYY-MM-DD.md`:

- i slutet av dagen (eller under), lägg till ett avsnitt `## Retain` med 2–5 punkter som är:
  - narrativa (kontext över flera turer bevaras)
  - självständiga (kan stå för sig själva senare)
  - taggade med typ + entitetsomnämnanden

Exempel:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Minimal parsning:

- Typprefix: `W` (värld), `B` (erfarenhet/biografiskt), `O` (åsikt), `S` (observation/sammanfattning; oftast genererad)
- Entiteter: `@Peter`, `@warelay`, etc (slugs mappar till `bank/entities/*.md`)
- Åsiktens tillförlitlighet: `O(c=0.0..1.0)` valfritt

Om du inte vill att författare ska behöva tänka på detta: reflektionsjobbet kan härleda dessa punkter från resten av loggen, men att ha ett explicit avsnitt `## Retain` är den enklaste ”kvalitetshävarmen”.

### Recall: frågor mot det härledda indexet

Återkallelse bör stödja:

- **lexikal**: ”hitta exakta termer / namn / kommandon” (FTS5)
- **entitet**: ”berätta om X” (entitetssidor + entitetslänkade fakta)
- **temporal**: ”vad hände runt 27 nov” / ”sedan förra veckan”
- **åsikt**: “Vad föredrar Petr?” (med självförtroende + bevis)

Returformatet bör vara agentvänligt och citera källor:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (källdag, eller extraherat tidsintervall om tillgängligt)
- `entities` (`["Peter","warelay"]`)
- `content` (det narrativa faktumet)
- `source` (`memory/2025-11-27.md#L12` etc)

### Reflect: producera stabila sidor + uppdatera övertygelser

Reflektion är ett schemalagt jobb (dagligen eller heartbeat `ultrathink`) som:

- uppdaterar `bank/entities/*.md` från nyliga fakta (entitetssammanfattningar)
- uppdaterar `bank/opinions.md`-tillförlitlighet baserat på förstärkning/motsägelse
- föreslår valfritt ändringar i `memory.md` (”kärnliknande” hållbara fakta)

Åsiktsutveckling (enkelt, förklarbart):

- varje åsikt har:
  - påstående
  - tillförlitlighet `c ∈ [0,1]`
  - last_updated
  - evidenslänkar (stödjande + motsägande faktum-ID:n)
- när nya fakta anländer:
  - hitta kandidatåsikter via entitetsöverlapp + likhet (FTS först, inbäddningar senare)
  - uppdatera tillförlitlighet med små deltan; stora hopp kräver stark motsägelse + upprepat bevis

## CLI-integration: fristående vs djup integration

Rekommendation: **djup integration i OpenClaw**, men behåll ett separerbart kärnbibliotek.

### Varför integrera i OpenClaw?

- OpenClaw känner redan till:
  - arbetsytans sökväg (`agents.defaults.workspace`)
  - sessionsmodellen + heartbeats
  - loggning + felsökningsmönster
- Du vill att agenten själv ska anropa verktygen:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Varför ändå dela upp i ett bibliotek?

- hålla minneslogik testbar utan gateway/runtime
- återanvända från andra sammanhang (lokala skript, framtida desktopapp, etc.)

Form:
Minnesverktygen är tänkta att vara ett litet CLI + biblioteks­lager, men detta är enbart explorativt.

## ”S-Collide” / SuCo: när ska det användas (forskning)

Om ”S-Collide” syftar på **SuCo (Subspace Collision)**: det är en ANN-återhämtningsmetod som siktar på starka avvägningar mellan återkallelse/latens genom att använda inlärda/strukturerade kollisioner i delrum (artikel: arXiv 2411.14754, 2024).

Pragmatisk hållning för `~/.openclaw/workspace`:

- **börja inte** med SuCo.
- börja med SQLite FTS + (valfritt) enkla inbäddningar; du får de flesta UX-vinster direkt.
- överväg SuCo/HNSW/ScaNN-klassen av lösningar först när:
  - korpusen är stor (tiotusentals/hundratusentals segment)
  - brute-force-sökning över inbäddningar blir för långsam
  - återkallelsens kvalitet i meningsfull grad flaskhalsas av lexikal sökning

Offline-vänliga alternativ (i ökande komplexitet):

- SQLite FTS5 + metadatafilter (noll ML)
- Inbäddningar + brute force (fungerar förvånansvärt långt om antalet segment är lågt)
- HNSW-index (vanligt, robust; kräver en biblioteksbindning)
- SuCo (forskningsnivå; attraktivt om det finns en solid implementation du kan bädda in)

Öppen fråga:

- vilken är den **bästa** offline-inbäddningsmodellen för ”personlig assistent-minne” på dina maskiner (laptop + desktop)?
  - om du redan har Ollama: skapa inbäddningar med en lokal modell; annars skeppa en liten inbäddningsmodell i verktygskedjan.

## Minsta användbara pilot

Om du vill ha en minimal, ändå användbar version:

- Lägg till `bank/`-entitetssidor och ett avsnitt `## Retain` i dagliga loggar.
- Använd SQLite FTS för återkallelse med citeringar (sökväg + radnummer).
- Lägg till inbäddningar endast om återkallelsens kvalitet eller skala kräver det.

## Referenser

- Letta / MemGPT-koncept: ”core memory blocks” + ”archival memory” + verktygsdriven självredigerande minne.
- Hindsight Technical Report: ”retain / recall / reflect”, fyrnätverksminne, extraktion av narrativa fakta, utveckling av åsikters tillförlitlighet.
- SuCo: arXiv 2411.14754 (2024): ”Subspace Collision” approximativ närmaste-granne-återhämtning.
