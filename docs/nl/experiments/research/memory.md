---
summary: "Onderzoeksnotities: offline geheugensysteem voor Clawd-werkruimtes (Markdown als bron van waarheid + afgeleide index)"
read_when:
  - Ontwerpen van werkruimtegeheugen (~/.openclaw/workspace) voorbij dagelijkse Markdown-logs
  - Deciding: "Beslissen: zelfstandige CLI vs diepe OpenClaw-integratie"
  - Offline terughalen + reflectie toevoegen (retain/recall/reflect)
title: "Werkruimtegeheugenonderzoek"
---

# Werkruimtegeheugen v2 (offline): onderzoeksnotities

Doel: Clawd-achtige werkruimte (`agents.defaults.workspace`, standaard `~/.openclaw/workspace`) waarin “geheugen” wordt opgeslagen als één Markdown-bestand per dag (`memory/YYYY-MM-DD.md`) plus een kleine set stabiele bestanden (bijv. `memory.md`, `SOUL.md`).

Dit document stelt een **offline-first** geheugenarchitectuur voor die Markdown behoudt als de canonieke, te beoordelen bron van waarheid, maar **gestructureerde recall** toevoegt (zoeken, entiteitssamenvattingen, betrouwbaarheidsupdates) via een afgeleide index.

## Waarom veranderen?

De huidige opzet (één bestand per dag) is uitstekend voor:

- “append-only” journaling
- bewerken door mensen
- duurzaamheid + auditbaarheid met git
- laagdrempelige vastlegging (“schrijf het gewoon op”)

Zwak voor:

- terughalen met hoge recall (“wat hebben we over X besloten?”, “de vorige keer dat we Y probeerden?”)
- entiteitsgerichte antwoorden (“vertel me over Alice / The Castle / warelay”) zonder veel bestanden opnieuw te lezen
- stabiliteit van meningen/voorkeuren (en bewijs wanneer dit verandert)
- tijdsbeperkingen (“wat was waar in nov 2025?”) en conflictresolutie

## Ontwerpdoelen

- **Offline**: werkt zonder netwerk; kan draaien op laptop/Castle; geen cloudafhankelijkheid.
- **Uitlegbaar**: opgehaalde items moeten te herleiden zijn (bestand + locatie) en te scheiden van inferentie.
- **Weinig ceremonie**: dagelijks loggen blijft Markdown, geen zwaar schemawerk.
- **Incrementeel**: v1 is nuttig met alleen FTS; semantisch/vector en grafen zijn optionele upgrades.
- **Agent-vriendelijk**: maakt “recall binnen tokenbudgetten” eenvoudig (kleine bundels feiten teruggeven).

## Noordster-model (Hindsight × Letta)

Twee onderdelen om te combineren:

1. **Letta/MemGPT-achtige besturingslus**

- houd een kleine “kern” altijd in context (persona + kerngebruikersfeiten)
- al het andere staat buiten context en wordt opgehaald via tools
- geheugenwrites zijn expliciete toolaanroepen (append/replace/insert), worden opgeslagen en daarna in de volgende beurt opnieuw geïnjecteerd

2. **Hindsight-achtige geheugensubstraat**

- scheid wat is waargenomen vs wat wordt geloofd vs wat is samengevat
- ondersteun retain/recall/reflect
- meningen met een betrouwbaarheidsniveau die met bewijs kunnen evolueren
- entiteitsbewuste retrieval + temporele queries (zelfs zonder volledige kennisgrafen)

## Voorgestelde architectuur (Markdown als bron van waarheid + afgeleide index)

### Canonieke opslag (git-vriendelijk)

Behoud `~/.openclaw/workspace` als canoniek, door mensen leesbaar geheugen.

Voorgestelde werkruimtelayout:

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

Notities:

- **Dagelijks log blijft dagelijks log**. Geen noodzaak om het naar JSON om te zetten.
- De `bank/`-bestanden zijn **gecureerd**, geproduceerd door reflectietaken, en kunnen nog steeds handmatig worden bewerkt.
- `memory.md` blijft “klein + kernachtig”: de dingen die je wilt dat Clawd elke sessie ziet.

### Afgeleide opslag (machine-recall)

Voeg een afgeleide index toe onder de werkruimte (niet noodzakelijk door git gevolgd):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Terug met:

- SQLite-schema voor feiten + entiteitskoppelingen + opiniemetadata
- SQLite **FTS5** voor lexicale recall (snel, klein, offline)
- optionele embeddingstabel voor semantische recall (nog steeds offline)

De index is altijd **opnieuw op te bouwen vanuit Markdown**.

## Retain / Recall / Reflect (operationele lus)

### Retain: dagelijkse logs normaliseren tot “feiten”

Het kerninzicht van Hindsight dat hier telt: sla **narratieve, op zichzelf staande feiten** op, geen kleine fragmenten.

Praktische regel voor `memory/YYYY-MM-DD.md`:

- voeg aan het einde van de dag (of tijdens) een `## Retain`-sectie toe met 2–5 bullets die:
  - narratief zijn (context over meerdere beurten blijft behouden)
  - op zichzelf staan (los later te begrijpen)
  - getagd zijn met type + entiteitsverwijzingen

Voorbeeld:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Minimale parsing:

- Type-prefix: `W` (wereld), `B` (ervaring/biografisch), `O` (mening), `S` (observatie/samenvatting; meestal gegenereerd)
- Entiteiten: `@Peter`, `@warelay`, enz. (slugs mappen naar `bank/entities/*.md`)
- Betrouwbaarheid van mening: `O(c=0.0..1.0)` optioneel

Als je auteurs hier niet over wilt laten nadenken: de reflectietaak kan deze bullets afleiden uit de rest van het log, maar een expliciete `## Retain`-sectie is de eenvoudigste “kwaliteitshefboom”.

### Recall: queries over de afgeleide index

Recall moet ondersteunen:

- **lexicaal**: “vind exacte termen / namen / opdrachten” (FTS5)
- **entiteit**: “vertel me over X” (entiteitspagina’s + aan entiteit gekoppelde feiten)
- **temporeel**: “wat gebeurde er rond 27 nov” / “sinds vorige week”
- **mening**: “wat verkiest Peter?” (met betrouwbaarheid + bewijs)

Retourformaat moet agent-vriendelijk zijn en bronnen citeren:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (brondag, of geëxtraheerd tijdsbereik indien aanwezig)
- `entities` (`["Peter","warelay"]`)
- `content` (het narratieve feit)
- `source` (`memory/2025-11-27.md#L12` enz.)

### Reflect: stabiele pagina’s produceren + overtuigingen bijwerken

Reflectie is een geplande taak (dagelijks of heartbeat `ultrathink`) die:

- `bank/entities/*.md` bijwerkt op basis van recente feiten (entiteitssamenvattingen)
- `bank/opinions.md`-betrouwbaarheid bijwerkt op basis van bevestiging/tegenspraak
- optioneel bewerkingen voorstelt aan `memory.md` (“kernachtig” duurzame feiten)

Evolutie van meningen (eenvoudig, uitlegbaar):

- elke mening heeft:
  - uitspraak
  - betrouwbaarheid `c ∈ [0,1]`
  - last_updated
  - bewijskoppelingen (ondersteunende + tegensprekende feit-ID’s)
- wanneer nieuwe feiten binnenkomen:
  - vind kandidaatmeningen via entiteitsoverlap + gelijkenis (eerst FTS, later embeddings)
  - werk betrouwbaarheid bij met kleine delta’s; grote sprongen vereisen sterke tegenspraak + herhaald bewijs

## CLI-integratie: standalone vs diepe integratie

Aanbeveling: **diepe integratie in OpenClaw**, maar behoud een los te koppelen kernbibliotheek.

### Waarom integreren in OpenClaw?

- OpenClaw weet al:
  - het werkruimtepad (`agents.defaults.workspace`)
  - het sessiemodel + heartbeats
  - logging- en patronen voor problemen oplossen
- Je wilt dat de agent zelf de tools aanroept:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Waarom toch een bibliotheek splitsen?

- geheugenlogica testbaar houden zonder Gateway/runtime
- hergebruik in andere contexten (lokale scripts, toekomstige desktop-app, enz.)

Vorm:
De geheugentooling is bedoeld als een kleine CLI + bibliotheeklaag, maar dit is slechts verkennend.

## “S-Collide” / SuCo: wanneer te gebruiken (onderzoek)

Als “S-Collide” verwijst naar **SuCo (Subspace Collision)**: het is een ANN-retrievalbenadering die sterke recall/latency-afwegingen nastreeft door geleerde/gestructureerde botsingen in subruimtes te gebruiken (paper: arXiv 2411.14754, 2024).

Pragmatische kijk voor `~/.openclaw/workspace`:

- **begin niet** met SuCo.
- start met SQLite FTS + (optioneel) eenvoudige embeddings; je krijgt meteen de meeste UX-winst.
- overweeg SuCo/HNSW/ScaNN-achtige oplossingen pas wanneer:
  - de corpus groot is (tien-/honderdduizenden chunks)
  - brute-force embedding-zoekopdrachten te traag worden
  - recall-kwaliteit betekenisvol wordt begrensd door lexicaal zoeken

Offline-vriendelijke alternatieven (in toenemende complexiteit):

- SQLite FTS5 + metadatafilters (geen ML)
- Embeddings + brute force (werkt verrassend ver bij lage chunk-aantallen)
- HNSW-index (gangbaar, robuust; vereist een bibliotheekbinding)
- SuCo (onderzoeksklaar; aantrekkelijk als er een solide implementatie is die je kunt embedden)

Open vraag:

- wat is het **beste** offline embeddingmodel voor “persoonlijke assistent-geheugen” op jouw machines (laptop + desktop)?
  - als je al Ollama hebt: embed met een lokaal model; anders een klein embeddingmodel meeleveren in de toolchain.

## Kleinste nuttige pilot

Als je een minimale, toch nuttige versie wilt:

- Voeg `bank/`-entiteitspagina’s en een `## Retain`-sectie toe aan dagelijkse logs.
- Gebruik SQLite FTS voor recall met citaties (pad + regelnummers).
- Voeg embeddings alleen toe als recall-kwaliteit of schaal het vereist.

## Referenties

- Letta / MemGPT-concepten: “core memory blocks” + “archival memory” + tool-gedreven zelfbewerkend geheugen.
- Hindsight Technical Report: “retain / recall / reflect”, viernetwerkgeheugen, extractie van narratieve feiten, evolutie van opiniebetrouwbaarheid.
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision” approximate nearest neighbor retrieval.
