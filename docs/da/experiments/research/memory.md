---
summary: "Forskningsnoter: offline hukommelsessystem til Clawd-workspaces (Markdown som source-of-truth + afledt indeks)"
read_when:
  - Design af workspace-hukommelse (~/.openclaw/workspace) ud over daglige Markdown-logs
  - Deciding: standalone CLI vs dyb OpenClaw integration
  - Tilføjelse af offline genkaldelse + refleksion (retain/recall/reflect)
title: "Workspace Memory Research"
---

# Workspace Memory v2 (offline): forskningsnoter

Mål: Clawd-lignende workspace (`agents.defaults.workspace`, standard `~/.openclaw/workspace`), hvor “hukommelse” lagres som én Markdown-fil pr. dag (`memory/YYYY-MM-DD.md`) plus et lille sæt stabile filer (fx `memory.md`, `SOUL.md`).

Dette dokument foreslår en **offline-first** hukommelsesarkitektur, der bevarer Markdown som den kanoniske, gennemgåelige source-of-truth, men tilføjer **struktureret genkaldelse** (søgning, entitetssammendrag, konfidensopdateringer) via et afledt indeks.

## Hvorfor ændre noget?

Den nuværende opsætning (én fil pr. dag) er fremragende til:

- “append-only” journaling
- menneskelig redigering
- git-baseret holdbarhed + auditérbarhed
- lav friktion ved indfangning (“bare skriv det ned”)

Den er svag til:

- genfinding med høj recall (“hvad besluttede vi om X?”, “sidste gang vi prøvede Y?”)
- entitetscentrerede svar (“fortæl mig om Alice / The Castle / warelay”) uden at genlæse mange filer
- stabilitet i holdninger/præferencer (og evidens, når de ændrer sig)
- tidsbegrænsninger (“hvad der var sandt i løbet af Nov 2025?”) og konfliktløsning

## Designmål

- **Offline**: fungerer uden netværk; kan køre på laptop/Castle; ingen cloud-afhængighed.
- **Forklarbar**: hentede elementer skal kunne tilskrives (fil + placering) og adskilles fra inferens.
- **Lav ceremoni**: daglig logning forbliver Markdown, intet tungt skema-arbejde.
- **Inkrementel**: v1 er nyttig med kun FTS; semantik/vektorer og grafer er valgfrie opgraderinger.
- **Agent-venlig**: gør “genkaldelse inden for token-budgetter” nem (returnér små bundter af fakta).

## Nordstjernemodel (Hindsight × Letta)

To dele, der skal blandes:

1. **Letta/MemGPT-stil kontrol-loop**

- behold en lille “kerne” altid i kontekst (persona + centrale brugerfakta)
- alt andet er uden for kontekst og hentes via værktøjer
- hukommelsesskrivninger er eksplicitte værktøjskald (append/replace/insert), persisteres og genindsættes derefter i næste tur

2. **Hindsight-stil hukommelsessubstrat**

- adskil det observerede fra det troede fra det sammenfattede
- understøt retain/recall/reflect
- holdninger med konfidens, der kan udvikle sig med evidens
- entitetsbevidst genfinding + tidslige forespørgsler (selv uden fulde vidensgrafer)

## Foreslået arkitektur (Markdown som source-of-truth + afledt indeks)

### Kanonisk lager (git-venligt)

Behold `~/.openclaw/workspace` som kanonisk, menneskeligt læsbar hukommelse.

Foreslået workspace-layout:

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

Noter:

- **Daglig log forbliver dagbog**. Ingen grund til at gøre det til JSON.
- Filerne `bank/` er **kuraterede**, produceret af refleksionsjobs, og kan stadig redigeres manuelt.
- `memory.md` forbliver “lille + kerne-agtig”: de ting, du vil have Clawd til at se i hver session.

### Afledt lager (maskinel genkaldelse)

Tilføj et afledt indeks under workspacet (ikke nødvendigvis git-tracket):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Understøt det med:

- SQLite-skema til fakta + entitetslinks + holdningsmetadata
- SQLite **FTS5** til leksikal genkaldelse (hurtig, lille, offline)
- valgfri embeddings-tabel til semantisk genkaldelse (stadig offline)

Indekset er altid **genopbyggeligt fra Markdown**.

## Retain / Recall / Reflect (operationelt loop)

### Retain: normalisér daglige logs til “fakta”

Hindsights centrale indsigt, der er vigtig her: gem **narrative, selvstændige fakta**, ikke små snippets.

Praktisk regel for `memory/YYYY-MM-DD.md`:

- ved slutningen af dagen (eller undervejs) tilføj en `## Retain`-sektion med 2–5 bullets, der er:
  - narrative (krydsturs-kontekst bevaret)
  - selvstændige (giver mening alene senere)
  - tagget med type + entitetsreferencer

Eksempel:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Minimal parsing:

- Type-præfiks: `W` (world), `B` (experience/biographical), `O` (opinion), `S` (observation/summary; typisk genereret)
- Enheder: `@Peter`, `@warelay`, etc (slugs map to `bank/entities/*.md`)
- Holdningskonfidens: `O(c=0.0..1.0)` valgfri

Hvis du ikke vil have, at forfattere skal tænke over det: refleksionsjobbet kan udlede disse bullets fra resten af loggen, men at have en eksplicit `## Retain`-sektion er den nemmeste “kvalitetsløftestang”.

### Recall: forespørgsler over det afledte indeks

Genkaldelse bør understøtte:

- **leksikal**: “find eksakte termer / navne / kommandoer” (FTS5)
- **entitet**: “fortæl mig om X” (entitetssider + entitetslinkede fakta)
- **temporal**: “hvad der skete omkring november 27” / “siden sidste uge”
- **opinion**: “hvad foretrækker Peter her?” (med tillid + evidens)

Returformat bør være agent-venligt og citere kilder:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (kildedag eller udtrukket tidsinterval, hvis til stede)
- `entities` (`["Peter","warelay"]`)
- `content` (det narrative faktum)
- `source` (`memory/2025-11-27.md#L12` osv.)

### Reflect: producer stabile sider + opdatér overbevisninger

Refleksion er et planlagt job (dagligt eller heartbeat `ultrathink`), der:

- opdaterer `bank/entities/*.md` fra nylige fakta (entitetssammendrag)
- opdaterer `bank/opinions.md`-konfidens baseret på forstærkning/modsigelse
- eventuelt foreslår redigeringer til `memory.md` (“core-ish” holdbare facts)

Udvikling af holdninger (simpel, forklarbar):

- hver holdning har:
  - udsagn
  - konfidens `c ∈ [0,1]`
  - last_updated
  - evidenslinks (understøttende + modsigende fakt-ID’er)
- når nye fakta ankommer:
  - find kandidat-holdninger via entitetsoverlap + lighed (FTS først, embeddings senere)
  - opdatér konfidens med små deltaer; store spring kræver stærk modsigelse + gentagen evidens

## CLI-integration: selvstændig vs. dyb integration

Anbefaling: **dyb integration i OpenClaw**, men behold et adskilleligt kernbibliotek.

### Hvorfor integrere i OpenClaw?

- OpenClaw kender allerede:
  - workspace-stien (`agents.defaults.workspace`)
  - sessionsmodellen + heartbeats
  - logging + fejlsøgningsmønstre
- Du vil have, at agenten selv kalder værktøjerne:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Hvorfor stadig splitte et bibliotek?

- hold hukommelseslogik testbar uden gateway/runtime
- genbrug fra andre kontekster (lokale scripts, fremtidig desktop-app osv.)

Form:
Hukommelsesværktøjerne er tænkt som et lille CLI + biblioteks-lag, men dette er kun eksplorativt.

## “S-Collide” / SuCo: hvornår man skal bruge det (research)

Hvis “S-Collide” refererer til **SuCo (Subspace Collision)**: det er en ANN-genfindingsmetode, der sigter mod stærke recall/latency-afvejninger ved at bruge lærte/strukturerede kollisioner i subrum (artikel: arXiv 2411.14754, 2024).

Pragmatisk take for `~/.openclaw/workspace`:

- **start ikke** med SuCo.
- start med SQLite FTS + (valgfrit) simple embeddings; du får de fleste UX-gevinster med det samme.
- overvej SuCo/HNSW/ScaNN-klassen først når:
  - korpuset er stort (titusinder/hundredtusinder af chunks)
  - brute-force embeddingsøgning bliver for langsom
  - recall-kvalitet er meningsfuldt flaskehalsen ved leksikal søgning

Offline-venlige alternativer (stigende kompleksitet):

- SQLite FTS5 + metadatafiltre (ingen ML)
- Embeddings + brute force (rækker overraskende langt ved lavt antal chunks)
- HNSW-indeks (almindeligt, robust; kræver en biblioteksbinding)
- SuCo (research-grade; attraktivt hvis der findes en solid implementation, du kan indlejre)

Åbent spørgsmål:

- hvad er den **bedste** offline embeddings-model til “personlig assistent-hukommelse” på dine maskiner (laptop + desktop)?
  - hvis du allerede har Ollama: embed med en lokal model; ellers lever en lille embeddings-model med i værktøjskæden.

## Mindste nyttige pilot

Hvis du vil have en minimal, men stadig nyttig version:

- Tilføj `bank/`-entitetssider og en `## Retain`-sektion i daglige logs.
- Brug SQLite FTS til genkaldelse med citationer (sti + linjenumre).
- Tilføj embeddings kun hvis recall-kvalitet eller skala kræver det.

## Referencer

- Letta / MemGPT-koncepter: “core memory blocks” + “archival memory” + værktøjsdrevet selvredigerende hukommelse.
- Hindsight Technical Report: “retain / recall / reflect”, hukommelse med fire netværk, udtræk af narrative fakta, udvikling af holdningskonfidens.
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision” approximate nearest neighbor retrieval.
